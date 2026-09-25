/**
 * The service worker — the extension's background context.
 *
 * Three properties of MV3 shape everything here:
 *
 * 1. **It is terminated when idle** (~30s) and restarted on the next event.
 *    Module-level variables do not survive that, so anything worth keeping
 *    goes to `chrome.storage`. The one module-level value below is an
 *    in-flight promise used purely to deduplicate concurrent refreshes within
 *    a single worker lifetime; losing it is harmless.
 * 2. **It has no DOM.** No `window`, no `document`, no `localStorage`.
 * 3. **Its origin is `chrome-extension://`**, so every Canvas call is
 *    cross-origin — which is why `credentials: "include"` and
 *    `host_permissions` both matter. See `src/canvas/client.ts`.
 *
 * It owns all fetching, rather than the popup doing it, because a popup's
 * JavaScript context is destroyed the moment it closes — taking any in-flight
 * request with it. Work started here survives the popup being dismissed.
 */

import { fetchActiveCourses, fetchUpcomingTasks, fetchUser } from "@/src/canvas/api";
import { CanvasError, SessionExpiredError } from "@/src/canvas/errors";
import {
  EMPTY_SNAPSHOT,
  type Request,
  type Snapshot,
  type SnapshotError,
} from "@/src/lib/messages";
import { loadSnapshot, saveSnapshot } from "@/src/lib/storage";

/** Cached data older than this is refreshed on open. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Deduplicates concurrent refreshes.
 *
 * Opening the popup and the Upcoming page together would otherwise fire two
 * identical sets of Canvas requests. Not persisted — it only needs to hold for
 * as long as one worker lifetime.
 */
let inFlight: Promise<Snapshot> | null = null;

function describeError(error: unknown): SnapshotError {
  if (error instanceof SessionExpiredError) {
    return { kind: "session-expired", message: error.message };
  }
  if (error instanceof CanvasError) {
    return { kind: "other", message: error.message };
  }
  if (error instanceof TypeError) {
    // `fetch` rejects with TypeError for network-level failures, including a
    // redirect to a host this extension has no permission for.
    return {
      kind: "network",
      message: "Could not reach Canvas. Check your connection and that you're signed in.",
    };
  }
  return { kind: "other", message: String(error) };
}

/** Fetch everything from Canvas and cache it. */
async function refresh(): Promise<Snapshot> {
  const previous = await loadSnapshot();

  try {
    // Courses first: tasks are labelled with their course name, so the lookup
    // has to exist before planner items are normalised.
    const [user, courses] = await Promise.all([fetchUser(), fetchActiveCourses()]);
    const tasks = await fetchUpcomingTasks(courses);

    const snapshot: Snapshot = {
      user,
      courses,
      tasks,
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    await saveSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    console.warn("[canvas-archiver] refresh failed", error);
    // Keep whatever was cached and attach the error, so the UI can show stale
    // data with a warning rather than going blank.
    const failed: Snapshot = { ...previous, error: describeError(error) };
    await saveSnapshot(failed);
    return failed;
  }
}

/** Refresh, collapsing concurrent callers onto one set of requests. */
function refreshOnce(): Promise<Snapshot> {
  inFlight ??= refresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Cached data if it is fresh enough, otherwise a refresh. */
async function getSnapshot(): Promise<Snapshot> {
  const cached = await loadSnapshot();

  if (cached.fetchedAt && !cached.error) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < STALE_AFTER_MS) return cached;
  }

  return refreshOnce();
}

export default defineBackground(() => {
  /**
   * The message bus.
   *
   * `return true` keeps the channel open for the async `sendResponse`.
   * Omitting it is the single most common MV3 bug, and it fails *silently* —
   * the sender's promise resolves to `undefined` with no error logged in
   * either console.
   */
  chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
    const handler =
      message?.type === "REFRESH"
        ? refreshOnce
        : message?.type === "GET_SNAPSHOT"
          ? getSnapshot
          : null;

    if (!handler) return false;

    handler()
      .then(sendResponse)
      .catch((error: unknown) => {
        // A handler must always reply. A silent failure here would hang the UI.
        sendResponse({ ...EMPTY_SNAPSHOT, error: describeError(error) });
      });

    return true;
  });
});
