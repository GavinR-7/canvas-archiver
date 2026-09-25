/**
 * The message protocol between extension surfaces.
 *
 * MV3 contexts — popup, extension pages, content scripts, service worker —
 * are isolated and cannot call each other's functions. They exchange messages
 * over `chrome.runtime`, and those messages are **structured-cloned**, so only
 * plain data crosses: no functions, no class instances, no `Response` objects.
 *
 * Typing both ends against this file is what stops that boundary becoming a
 * source of silent `undefined`s.
 */

import type { CanvasUser, Course, Task } from "@/src/types/canvas";

/** Messages a UI surface can send to the service worker. */
export type Request =
  /** Return whatever is cached, fetching only if nothing is. */
  | { type: "GET_SNAPSHOT" }
  /** Re-fetch from Canvas regardless of cache. */
  | { type: "REFRESH" };

export type SnapshotErrorKind = "session-expired" | "network" | "other";

export interface SnapshotError {
  kind: SnapshotErrorKind;
  message: string;
}

/**
 * Everything the UI needs, in one object.
 *
 * A single snapshot rather than several endpoints keeps the popup's render
 * atomic: there is no state where courses have loaded but tasks have not.
 *
 * `error` is a field rather than a thrown exception because an error must
 * survive the structured clone — a thrown `Error` crossing `sendMessage`
 * arrives as `undefined`.
 */
export interface Snapshot {
  user: CanvasUser | null;
  courses: Course[];
  tasks: Task[];
  /** When this data was fetched from Canvas. ISO 8601 UTC. */
  fetchedAt: string | null;
  /** Non-null when the last fetch failed. Stale data may still be present. */
  error: SnapshotError | null;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  user: null,
  courses: [],
  tasks: [],
  fetchedAt: null,
  error: null,
};

/** Typed wrapper around `chrome.runtime.sendMessage`. */
export async function sendMessage(request: Request): Promise<Snapshot> {
  const reply = (await chrome.runtime.sendMessage(request)) as Snapshot | undefined;
  // A listener that forgets `return true` resolves to undefined rather than
  // erroring, so this guard turns the most common MV3 bug into a real message.
  if (!reply) {
    throw new Error(
      "The extension's background worker did not reply. Try reloading the extension.",
    );
  }
  return reply;
}
