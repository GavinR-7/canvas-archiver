/**
 * Persistence.
 *
 * `chrome.storage.local` rather than `localStorage`, for one decisive reason:
 * **the MV3 service worker has no DOM**, so `localStorage` does not exist
 * there. `chrome.storage` is available in every extension context, and it is
 * async, which `localStorage` is not.
 *
 * Everything written here stays on this machine. There is no sync, no backend
 * and no telemetry — `chrome.storage.sync` is deliberately not used, since it
 * would push course data through a Google account.
 */

import { EMPTY_SNAPSHOT, type Snapshot } from "./messages";

const SNAPSHOT_KEY = "snapshot.v1";

/** Read the cached snapshot, or an empty one if nothing is stored. */
export async function loadSnapshot(): Promise<Snapshot> {
  try {
    const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
    const snapshot = stored[SNAPSHOT_KEY] as Snapshot | undefined;
    return snapshot ?? EMPTY_SNAPSHOT;
  } catch {
    // Storage being unavailable should degrade to "no cache", never throw.
    return EMPTY_SNAPSHOT;
  }
}

/** Persist a snapshot. Failures are non-fatal: the UI already has the data. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  try {
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
  } catch (error) {
    console.warn("[canvas-archiver] could not cache snapshot", error);
  }
}

/** Forget everything stored locally. */
export async function clearSnapshot(): Promise<void> {
  await chrome.storage.local.remove(SNAPSHOT_KEY);
}
