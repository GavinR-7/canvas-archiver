/**
 * The per-course manifest: what has been saved, so the next run only fetches
 * what is new or changed, and so the nightly knowledge feed can see what
 * arrived. Keyed by `source` (`canvas:file/<id>`), never by file name.
 */

import { Sha256 } from "./sha256";
import type { PlannedItem } from "./plan";
import type { Method } from "./transfer";

export interface ManifestEntry {
  path: string[];
  size: number;
  /** Hash of the bytes as written. Null when the writer could not hash (Downloads fallback). */
  sha256: string | null;
  /** Canvas's modified time at save. Null for items Canvas gives no timestamp (syllabus). */
  modifiedAt: string | null;
  savedAt: string;
  /**
   * The host's ETag (or Last-Modified) at save, for items from a host that gives
   * no modified time up front (Gradescope). Sent back as If-None-Match /
   * If-Modified-Since so an unchanged file costs a 304. Absent: re-fetch and compare the hash.
   */
  validator?: string | null;
  /** How the bytes were fetched; "downloads" = saved by the browser under Downloads/<path>, not in the folder. Absent in older manifests. */
  method?: Method;
  /** For method "downloads": where the browser put the file, relative to the Downloads folder. The archive folder does not hold it. */
  savedTo?: string;
}

export interface CourseManifest {
  version: 1;
  courseId: number;
  entries: Record<string, ManifestEntry>;
}

export const MANIFEST_FILE = ".canvas-archive.json";

export function emptyManifest(courseId: number): CourseManifest {
  return { version: 1, courseId, entries: {} };
}

/** The folder's manifest names a different Canvas course than the one about to be written into it. */
export class ForeignCourseError extends Error {
  constructor(
    readonly folder: string,
    readonly ownerId: number,
  ) {
    super(
      `${folder} already holds another course's archive (Canvas course ${ownerId}); nothing was written there. Select the other course in the same run once so each keeps its own folder, or move that folder aside.`,
    );
    this.name = "ForeignCourseError";
  }
}

/** The Canvas course id a manifest file says it belongs to, or null when it is missing, unreadable or not a manifest. */
export function manifestOwner(text: string | null): number | null {
  if (!text) return null;
  try {
    const data = JSON.parse(text) as Partial<CourseManifest>;
    return data.version === 1 && typeof data.courseId === "number" && typeof data.entries === "object" ? data.courseId : null;
  } catch {
    return null;
  }
}

/** A missing or corrupt manifest means "nothing saved yet", never a crash. A manifest for another course is refused by the folder store (`ForeignCourseError`), not reset. */
export function parseManifest(text: string | null, courseId: number): CourseManifest {
  if (!text) return emptyManifest(courseId);
  try {
    const data = JSON.parse(text) as Partial<CourseManifest>;
    if (data.version !== 1 || data.courseId !== courseId || typeof data.entries !== "object" || !data.entries) {
      return emptyManifest(courseId);
    }
    return { version: 1, courseId, entries: data.entries };
  } catch {
    return emptyManifest(courseId);
  }
}

/** "revalidate": ask the host (conditional GET, else full GET + hash compare); the runner decides from the answer. */
export type Decision = "new" | "changed" | "unchanged" | "revalidate";

const encoder = new TextEncoder();

export function hashText(text: string): string {
  return new Sha256().update(encoder.encode(text)).digest();
}

/**
 * Should this item be fetched?
 *
 * - No entry: new.
 * - Inline items (pages etc.) are compared by the hash of their rendered text,
 *   since Canvas timestamps for them are missing or unreliable.
 * - Files are compared by Canvas's modified time (size if there is none).
 * - Moved (module renamed or file re-filed): changed, so the tree stays true.
 * - `onDiskSize` (archive layout only): a known file that was deleted or
 *   truncated locally is fetched again. `undefined` means "not checked".
 */
export function decide(
  item: PlannedItem,
  entry: ManifestEntry | undefined,
  onDiskSize?: number | null,
): Decision {
  if (!entry) return "new";
  if (entry.path.join("/") !== item.path.join("/")) return "changed";
  if (onDiskSize !== undefined && onDiskSize !== entry.size) return onDiskSize === null ? "new" : "changed";
  if (item.content !== null) return entry.sha256 === hashText(item.content) ? "unchanged" : "changed";
  // Gradescope gives no size or time up front, and a URL is not a version (an instructor can
  // replace a handout in place), so only the host can say whether it changed.
  if (item.session !== undefined) return "revalidate";
  // The size Canvas reports and the bytes written can differ (encodings, CDN), so
  // size only decides when Canvas gave no modified time.
  if (item.modifiedAt !== null) return entry.modifiedAt === item.modifiedAt ? "unchanged" : "changed";
  return entry.size === item.size ? "unchanged" : "changed";
}

export interface SavedRecord {
  /** Course folder or slug the item belongs to. */
  course: string;
  source: string;
  path: string[];
  size: number;
  sha256: string | null;
  modifiedAt: string | null;
  /** Inbox-relative place the bytes were staged at (ingest layout), when it differs from `path`. */
  stage?: string;
}

/**
 * The batch file HQ's nightly ingest reads (knowledge/courses/README.md,
 * "Ingest contract"). Paths are relative to the inbox and `/`-separated.
 * `courses` is an addition to the contract: the Canvas id for each slug, so
 * ingest can fill `course.json` without asking Canvas.
 */
export interface Batch {
  createdAt: string;
  courses: Record<string, number>;
  files: {
    course: string;
    path: string;
    source: string;
    canvasModifiedAt: string | null;
    size: number;
    sha256: string | null;
    /** Where the bytes sit in the inbox when that is not `path` (each batch stages its own copy). */
    stage?: string;
  }[];
}

export function buildBatch(createdAt: Date, saved: SavedRecord[], courses: Record<string, number>): Batch {
  return {
    createdAt: createdAt.toISOString(),
    courses,
    files: saved.map((s) => ({
      course: s.course,
      path: s.path.join("/"),
      source: s.source,
      canvasModifiedAt: s.modifiedAt,
      size: s.size,
      sha256: s.sha256,
      ...(s.stage ? { stage: s.stage } : {}),
    })),
  };
}

/**
 * `2026-10-15T14:03:09.123Z` → `2026-10-15T140309.json`, the contract's file name (no colons: Windows).
 * `runId` makes it `2026-10-15T140309-<runId>.json`: the timestamp prefix keeps names chronological for
 * hq-ingest, the id keeps two runs in the same second from sharing a name.
 */
export function batchFileName(at: Date, runId?: string): string {
  return `${at.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "")}${runId ? `-${runId}` : ""}.json`;
}

/** Eight random hex characters, one per run. */
export function newRunId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
}
