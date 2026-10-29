/**
 * Runs archive plans against a "sink" (somewhere files can be written).
 *
 * The sink is an interface so the runner is tested without a browser, and so
 * the folder sink (File System Access API) and the Downloads fallback
 * (`chrome.downloads`) share one loop. Per-item failures are recorded and the
 * run continues: one locked file must not abandon four hundred others.
 *
 * Incremental: each course has a manifest keyed by source id. An item whose
 * entry matches (same path, same modified time and size, or same text hash) is
 * not fetched again. The manifest is checkpointed during the run, so closing
 * the tab loses at most a few items of progress.
 */

import {
  batchFileName,
  newRunId,
  buildBatch,
  decide,
  emptyManifest,
  ForeignCourseError,
  type CourseManifest,
  type Decision,
  type ManifestEntry,
  type SavedRecord,
} from "./manifest";
import type { Layout } from "./layout";
import { scrubUrls, type Method } from "./transfer";
import type { CoursePlan, ItemRole, PlannedItem } from "./plan";

export interface SaveResult {
  size: number;
  /** Null when the sink cannot hash what it wrote. */
  sha256: string | null;
  /** The host's ETag / Last-Modified for this response, if it sent one. */
  validator?: string | null;
  /** The host answered 304 to a conditional request: nothing was written, the saved file stands. */
  notModified?: boolean;
  /** How the bytes were obtained; "downloads" means the browser saved them under Downloads, not in the folder. */
  method?: Method;
  /** With method "downloads": the Downloads-relative path actually written. */
  savedTo?: string;
}

export interface FileSink {
  /** Size of the file at `path`, or null if absent. Sinks that cannot look return null. */
  size(path: string[]): Promise<number | null>;
  /** Write one item (fetching `item.url`, or writing `item.content`). */
  save(item: PlannedItem, prior?: ManifestEntry): Promise<SaveResult>;
  readText(path: string[]): Promise<string | null>;
  writeText(path: string[], text: string): Promise<void>;
  /** False for sinks that cannot read back or hash (the Downloads fallback). */
  readonly keepsRecords: boolean;
}

/** Where a course's manifest lives. */
export interface ManifestStore {
  load(plan: CoursePlan): Promise<CourseManifest>;
  save(plan: CoursePlan, manifest: CourseManifest): Promise<void>;
}

/** Set when the file is in the browser's Downloads folder, not in the archive folder. */
export const IN_DOWNLOADS = "saved to Downloads, not in the archive folder";

export type ItemOutcome =
  | { source: string; path: string[]; status: "saved"; decision: Exclude<Decision, "unchanged" | "revalidate">; inDownloads?: string; role?: ItemRole }
  | { source: string; path: string[]; status: "unchanged"; inDownloads?: string }
  | { source: string; path: string[]; status: "failed"; message: string; inDownloads?: undefined };

export interface RunResult {
  saved: number;
  unchanged: number;
  failed: number;
  /** Of `saved`, how many the browser's downloader wrote under Downloads because the file host refused a direct read. */
  viaDownloads: number;
  /** Of `unchanged`, how many are only in Downloads from an earlier run (so not in the archive folder). */
  alreadyInDownloads: number;
  outcomes: ItemOutcome[];
  cancelled: boolean;
  /** Name of the batch file written (ingest layout), or null. */
  batch: string | null;
  elapsedMs: number;
}

export interface RunOptions {
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** Names this run's staging folder and batch file; random per run unless a test fixes it. */
  runId?: string;
  onProgress?: (done: number, total: number, last: ItemOutcome) => void;
}

const CHECKPOINT_EVERY = 25;

export async function runArchive(
  plans: CoursePlan[],
  layout: Layout,
  sink: FileSink,
  store: ManifestStore | null,
  { concurrency = 3, signal, now = () => new Date(), runId = newRunId(), onProgress }: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const keep = store !== null && sink.keepsRecords;
  const batchAt = now();

  // Ingest: every run stages its bytes under its own folder, so a later run can never
  // overwrite what an earlier, not-yet-ingested batch still points at.
  const stageDir = layout.id === "ingest" && sink.keepsRecords ? ["_staged", batchFileName(batchAt, runId).replace(/\.json$/, "")] : null;

  const manifests = new Map<number, CourseManifest>();
  const outcomes: ItemOutcome[] = [];
  const refused = new Set<number>();
  for (const plan of plans) {
    try {
      manifests.set(plan.courseId, keep ? await store.load(plan) : emptyManifest(plan.courseId));
    } catch (error) {
      if (!(error instanceof ForeignCourseError)) throw error;
      // This folder is another course's: refuse this course, carry on with the rest.
      refused.add(plan.courseId);
      for (const item of plan.items) outcomes.push({ source: item.source, path: item.path, status: "failed", message: error.message });
    }
  }
  const active = plans.filter((plan) => !refused.has(plan.courseId));
  const refusedItems = outcomes.length;

  const queue = active.flatMap((plan) => plan.items.map((item) => ({ plan, item })));
  const saved: SavedRecord[] = [];
  let next = 0;
  let sinceCheckpoint = 0;
  let viaDownloads = 0;
  let checkpointing: Promise<void> | null = null;

  const persist = async () => {
    if (!keep) return;
    for (const plan of active) await store.save(plan, manifests.get(plan.courseId) as CourseManifest);
  };

  const checkpoint = () => {
    // One at a time; a checkpoint that finds one running just waits for the next.
    checkpointing ??= persist().finally(() => {
      checkpointing = null;
    });
    return checkpointing;
  };

  const one = async ({ plan, item }: (typeof queue)[number]): Promise<ItemOutcome> => {
    const manifest = manifests.get(plan.courseId) as CourseManifest;
    try {
      // A file the browser downloaded lives under Downloads, not in this folder: there is nothing here to verify.
      const onDisk = layout.verifyDisk && sink.keepsRecords && manifest.entries[item.source]?.method !== "downloads" ? await sink.size(item.path) : undefined;
      const decision = keep ? decide(item, manifest.entries[item.source], onDisk) : "new";
      const prior = manifest.entries[item.source];
      // Not re-downloaded (that would add a "(1)" copy each run), but never reported as present in the folder.
      if (decision === "unchanged") {
        return prior?.method === "downloads"
          ? { source: item.source, path: item.path, status: "unchanged", inDownloads: prior.savedTo ?? item.path.join("/") }
          : { source: item.source, path: item.path, status: "unchanged" };
      }
      const stage = stageDir ? [...stageDir, ...item.path] : null;
      const result = await sink.save(stage ? { ...item, path: stage } : item, decision === "revalidate" ? prior : undefined);

      // Revalidated: the host said 304, or the bytes written hash the same as the saved ones.
      const same =
        decision === "revalidate" &&
        prior !== undefined &&
        (result.notModified === true || (result.sha256 !== null && result.sha256 === prior.sha256));
      if (same) {
        manifest.entries[item.source] = { ...prior, validator: result.validator ?? prior.validator ?? null };
        return { source: item.source, path: item.path, status: "unchanged" };
      }

      manifest.entries[item.source] = {
        path: item.path,
        size: result.size,
        sha256: result.sha256,
        modifiedAt: item.modifiedAt,
        savedAt: now().toISOString(),
        ...(result.method ? { method: result.method } : {}),
        ...(result.method === "downloads" ? { savedTo: result.savedTo ?? item.path.join("/") } : {}),
        ...(result.validator !== undefined ? { validator: result.validator } : {}),
      };
      if (result.method === "downloads") viaDownloads++;
      saved.push({
        course: plan.folder,
        source: item.source,
        path: item.path,
        size: result.size,
        sha256: result.sha256,
        modifiedAt: item.modifiedAt,
        ...(stage ? { stage: stage.join("/") } : {}),
      });
      return {
        source: item.source,
        path: item.path,
        status: "saved",
        decision: decision === "revalidate" ? "changed" : decision,
        ...(item.role ? { role: item.role } : {}),
        ...(result.method === "downloads" ? { inDownloads: result.savedTo ?? item.path.join("/") } : {}),
      };
    } catch (error) {
      // Sinks keep the signed URL out of their text; scrub again so nothing URL-shaped reaches the screen.
      const message = scrubUrls(error instanceof Error ? error.message : String(error));
      return { source: item.source, path: item.path, status: "failed", message };
    }
  };

  const worker = async () => {
    while (!signal?.aborted) {
      const entry = queue[next++];
      if (!entry) return;
      const outcome = await one(entry);
      outcomes.push(outcome);
      if (outcome.status === "saved" && ++sinceCheckpoint >= CHECKPOINT_EVERY) {
        sinceCheckpoint = 0;
        await checkpoint();
      }
      onProgress?.(outcomes.length - refusedItems, queue.length, outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  await checkpointing;
  await persist();

  // The ingest batch goes last: its presence tells HQ every listed file is on disk.
  let batch: string | null = null;
  if (layout.id === "ingest" && sink.keepsRecords && saved.length > 0) {
    const courses = Object.fromEntries(active.map((plan) => [plan.folder, plan.courseId]));
    const name = batchFileName(batchAt, runId);
    await sink.writeText(["_batches", name], `${JSON.stringify(buildBatch(batchAt, saved, courses), null, 2)}\n`);
    batch = name;
  }

  const count = (status: ItemOutcome["status"]) => outcomes.filter((o) => o.status === status).length;
  return {
    saved: count("saved"),
    unchanged: count("unchanged"),
    failed: count("failed"),
    viaDownloads,
    alreadyInDownloads: outcomes.filter((o) => o.status === "unchanged" && o.inDownloads !== undefined).length,
    outcomes,
    cancelled: signal?.aborted ?? false,
    batch,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Did every failure look like the file host refusing a cross-origin read?
 * `fetch` reports that as a bare TypeError with no status, which the sink
 * surfaces as "blocked". If nothing was saved and all failures are that, the
 * UI offers the Downloads-folder fallback.
 */
export function looksBlockedByCors(result: RunResult): boolean {
  const failures = result.outcomes.filter((o) => o.status === "failed");
  return (
    result.saved === 0 &&
    failures.length > 0 &&
    failures.every((o) => o.status === "failed" && o.message.startsWith("blocked:"))
  );
}
