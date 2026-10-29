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

import {
  fetchActiveCourses,
  fetchUpcomingTasks,
  fetchUser,
} from "@/src/canvas/api";
import { CanvasError, SessionExpiredError } from "@/src/canvas/errors";
import {
  EMPTY_SNAPSHOT,
  type Request,
  type Snapshot,
  type SnapshotError,
} from "@/src/lib/messages";
import { fetchGradescopeTasks } from "@/src/gradescope/api";
import { fetchEdTasks, type EdResult } from "@/src/ed/api";
import { fetchSyllabusTasks } from "@/src/dates/syllabus";
import { syllabusFileTasks } from "@/src/dates/syllabus-files";
import { browserSyllabusDeps } from "@/src/dates/syllabus-reader";
import { EXAM_DAYS, isExamTask } from "@/src/dates/exams";
import { mergeTasks } from "@/src/dates/merge";
import { loadManualExams, manualExamTasks, withManualExams } from "@/src/dates/manual-exams";
import { loadSettings } from "@/src/sync/settings";
import { syncDue } from "@/src/sync/run";
import { loadClasses } from "@/src/schedule/model";
import { loadFeed, minutesUntilHour } from "@/src/feed/settings";
import { hasConsent } from "@/src/consent/consent";
import { DEADLINE_LOOKAHEAD_DAYS, DEADLINE_OVERDUE_DAYS, taskWindow, tasksInWindow } from "@/src/lib/task-window";
import type { TaskSource } from "@/src/types/canvas";
import type { TaskRead } from "@/src/lib/source-read";
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

function describeError(error: unknown, service = "Canvas"): SnapshotError {
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
      message: `Could not reach ${service}. Check your connection and that you're signed in.`,
    };
  }
  return { kind: "other", message: String(error) };
}

/** A partial source may contribute fresh rows but cannot discard its cached rows. */
function retainedTasks(previous: Snapshot, source: TaskSource, read: TaskRead) {
  if (read.complete) return read.tasks;
  return [...new Map([...[...previous.tasks, ...(previous.exams ?? [])].filter((task) => task.source === source), ...read.tasks].map((task) => [task.id, task])).values()];
}

/** Fetch everything from Canvas and cache it. */
async function refresh(): Promise<Snapshot> {
  const previous = await loadSnapshot();
  const now = new Date();
  const dueWindow = taskWindow(now, DEADLINE_LOOKAHEAD_DAYS, DEADLINE_OVERDUE_DAYS);
  const previousAll = [...new Map([...previous.tasks, ...(previous.exams ?? [])].map((task) => [task.id, task])).values()];

  // Fetch once out to the exam horizon; retain the shared due.json window in tasks.
  // Gradescope runs alongside Canvas and fails independently. Its tasks from
  // the previous fetch are kept on failure so a flaky page doesn't blank them.
  const gradescope = fetchGradescopeTasks(EXAM_DAYS, now, DEADLINE_OVERDUE_DAYS).then(
    (read) => ({ tasks: retainedTasks(previous, "gradescope", read), complete: read.complete, error: read.complete ? null : describeError(read.error, "Gradescope") }),
    (error: unknown) => {
      console.warn("[canvas-archiver] gradescope refresh failed", error);
      return {
        tasks: previousAll.filter((task) => task.source === "gradescope"),
        complete: false,
        error: describeError(error, "Gradescope"),
      };
    },
  );

  try {
    // Courses first: tasks are labelled with their course name, so the lookup
    // has to exist before planner items are normalised.
    const [user, courses] = await Promise.all([fetchUser(), fetchActiveCourses()]);
    const planner = await fetchUpcomingTasks(courses, EXAM_DAYS, now, DEADLINE_OVERDUE_DAYS);
    const tasks = planner.complete ? planner.tasks : previousAll.filter((task) => task.source === "canvas");

    // Dates written in prose (syllabus, Ed announcements) are best-effort: each
    // fails alone, and its previous result is kept rather than blanking.
    const current = courses.filter((c) => !c.restricted);
    const syllabusRead = await fetchSyllabusTasks(courses, EXAM_DAYS, now, DEADLINE_OVERDUE_DAYS).catch((error: unknown): TaskRead => ({
      tasks: [], complete: false, unavailableCourseIds: courses.map((course) => course.id), error,
    }));
    // File dates remain best-effort locally; a known unreadable file cannot certify deletion.
    const syllabusFiles = await syllabusFileTasks(current, EXAM_DAYS, browserSyllabusDeps(), now).catch(() => ({
      tasks: [], unreadable: 1,
    }));
    const unavailable = new Set(syllabusRead.unavailableCourseIds);
    const syllabus = [
      ...previousAll.filter((task) => task.source === "syllabus" && (syllabusFiles.unreadable > 0 || unavailable.has(task.courseId))),
      ...syllabusRead.tasks,
      ...syllabusFiles.tasks,
    ];
    const syllabusComplete = syllabusRead.complete && syllabusFiles.unreadable === 0;
    const syllabusError = !syllabusRead.complete ? describeError(syllabusRead.error, "Canvas syllabus")
      : syllabusFiles.unreadable > 0 ? { kind: "other" as const, message: "Some syllabus files could not be read. Cached dates were kept." } : null;
    const edRead = await fetchEdTasks(current, EXAM_DAYS, now, DEADLINE_OVERDUE_DAYS).catch((error: unknown): EdResult => ({
      tasks: [], complete: false, unavailableCourseIds: current.map((course) => course.id), error, missed: [],
    }));
    const ed = retainedTasks(previous, "ed", edRead);
    const edError = edRead.complete ? null : edRead.missed?.length
      ? { kind: "other" as const, message: "Ed Discussion data is missing for " + edRead.missed.join(", ") + ". The other courses are up to date." }
      : describeError(edRead.error, "Ed Discussion");

    const gs = await gradescope;
    const manual = manualExamTasks(await loadManualExams(), courses);
    const all = [...tasks, ...gs.tasks, ...syllabus, ...ed, ...manual];
    const snapshot: Snapshot = {
      user,
      courses,
      tasks: mergeTasks(tasksInWindow(all, dueWindow)),
      exams: mergeTasks(all.filter(isExamTask)),
      fetchedAt: new Date().toISOString(),
      error: planner.complete ? null : describeError(planner.error),
      gradescopeError: gs.error,
      edError,
      syllabusError,
      sourceCompleteness: { canvas: planner.complete, gradescope: gs.complete, syllabus: syllabusComplete, ed: edRead.complete, manual: true },
    };
    await saveSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    console.warn("[canvas-archiver] refresh failed", error);
    // Keep whatever was cached and attach the error, so the UI can show stale
    // data with a warning rather than going blank.
    const gs = await gradescope;
    const failed: Snapshot = {
      ...previous,
      // Canvas data is stale, but a fresh Gradescope result is still good.
      tasks: mergeTasks([...previous.tasks.filter((task) => task.source !== "gradescope"), ...tasksInWindow(gs.tasks, dueWindow)]),
      exams: mergeTasks(withManualExams([...(previous.exams ?? []).filter((task) => task.source !== "gradescope"), ...gs.tasks.filter(isExamTask)], await loadManualExams(), previous.courses)),
      error: describeError(error),
      gradescopeError: gs.error,
      sourceCompleteness: { canvas: false, gradescope: gs.complete, syllabus: false, ed: false, manual: true },
    };
    await saveSnapshot(failed);
    return failed;
  }
}

/** No request leaves the browser before the person accepts the first-run disclosure. */
async function refreshWithConsent(): Promise<Snapshot> {
  if (!(await hasConsent())) return EMPTY_SNAPSHOT;
  return refresh();
}

/** Refresh, collapsing concurrent callers onto one set of requests. */
function refreshOnce(): Promise<Snapshot> {
  inFlight ??= refreshWithConsent().finally(() => {
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

/** Refresh from every source, then push due.json when the person has turned sync on. */
const FEED_ALARM = "nightly-feed";

/** (Re)create the daily alarm for the configured hour, or remove it. */
async function scheduleFeed() {
  const feed = await loadFeed();
  await chrome.alarms.clear(FEED_ALARM);
  if (feed.enabled) {
    void chrome.alarms.create(FEED_ALARM, {
      delayInMinutes: minutesUntilHour(new Date(), feed.hour),
      periodInMinutes: 24 * 60,
    });
  }
}

/** The run needs a page (folder handle, long loop), so open one without taking focus. */
async function startFeed() {
  if (!(await hasConsent()) || !(await loadFeed()).enabled) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("files.html?auto=feed"), active: false });
}

async function refreshAndSyncOnce(): Promise<Snapshot> {
  if (!(await hasConsent())) return EMPTY_SNAPSHOT;
  const snapshot = await refreshOnce();
  await syncDue(snapshot, await loadSettings(), new Date(), fetch, await loadClasses()).catch((error: unknown) => {
    console.warn("[canvas-archiver] due.json sync failed", error);
  });
  return snapshot;
}

// Share the entire refresh + both uploads, including manual requests during an
// alarm's PUT. Sharing only refreshOnce lets older and newer uploads race.
let syncInFlight: Promise<Snapshot> | null = null;
function refreshAndSync(): Promise<Snapshot> {
  syncInFlight ??= refreshAndSyncOnce().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

const REFRESH_ALARM = "refresh-and-sync";
const REFRESH_EVERY_MINUTES = 120;

export default defineBackground(() => {
  // Alarms persist across worker restarts, but only fire while Chrome is running.
  // Creating one with an existing name replaces it, so this is safe on every start.
  void chrome.alarms.get(REFRESH_ALARM).then((existing) => {
    if (!existing) void chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 1, periodInMinutes: REFRESH_EVERY_MINUTES });
  });
  void scheduleFeed();
  // First run: open a page that shows the disclosure (every page is gated).
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("upcoming.html") });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["feed.settings"]) void scheduleFeed();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REFRESH_ALARM) void refreshAndSync();
    if (alarm.name === FEED_ALARM) void startFeed();
  });

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
        : message?.type === "SYNC_NOW"
          ? refreshAndSync
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
