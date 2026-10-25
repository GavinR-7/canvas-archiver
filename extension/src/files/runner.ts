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
  buildBatch,
  decide,
  emptyManifest,
  type CourseManifest,
  type Decision,
  type SavedRecord,
} from "./manifest";
import type { Layout } from "./layout";
import type { CoursePlan, PlannedItem } from "./plan";

export interface SaveResult {
  size: number;
  /** Null when the sink cannot hash what it wrote. */
  sha256: string | null;
}

export interface FileSink {
  /** Size of the file at `path`, or null if absent. Sinks that cannot look return null. */
  size(path: string[]): Promise<number | null>;
  /** Write one item (fetching `item.url`, or writing `item.content`). */
  save(item: PlannedItem): Promise<SaveResult>;
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

export type ItemOutcome =
  | { source: string; path: string[]; status: "saved"; decision: Exclude<Decision, "unchanged"> }
  | { source: string; path: string[]; status: "unchanged" }
  | { source: string; path: string[]; status: "failed"; message: string };

export interface RunResult {
  saved: number;
  unchanged: number;
  failed: number;
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
  onProgress?: (done: number, total: number, last: ItemOutcome) => void;
}

const CHECKPOINT_EVERY = 25;

export async function runArchive(
  plans: CoursePlan[],
  layout: Layout,
  sink: FileSink,
  store: ManifestStore | null,
  { concurrency = 3, signal, now = () => new Date(), onProgress }: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const keep = store !== null && sink.keepsRecords;

  const manifests = new Map<number, CourseManifest>();
  for (const plan of plans) {
    manifests.set(plan.courseId, keep ? await store.load(plan) : emptyManifest(plan.courseId));
  }

  const queue = plans.flatMap((plan) => plan.items.map((item) => ({ plan, item })));
  const outcomes: ItemOutcome[] = [];
  const saved: SavedRecord[] = [];
  let next = 0;
  let sinceCheckpoint = 0;
  let checkpointing: Promise<void> | null = null;

  const persist = async () => {
    if (!keep) return;
    for (const plan of plans) await store.save(plan, manifests.get(plan.courseId) as CourseManifest);
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
      const onDisk = layout.verifyDisk && sink.keepsRecords ? await sink.size(item.path) : undefined;
      const decision = keep ? decide(item, manifest.entries[item.source], onDisk) : "new";
      if (decision === "unchanged") return { source: item.source, path: item.path, status: "unchanged" };

      const result = await sink.save(item);
      manifest.entries[item.source] = {
        path: item.path,
        size: result.size,
        sha256: result.sha256,
        modifiedAt: item.modifiedAt,
        savedAt: now().toISOString(),
        ...(item.fingerprint !== undefined ? { fingerprint: item.fingerprint } : {}),
      };
      saved.push({
        course: plan.folder,
        source: item.source,
        path: item.path,
        size: result.size,
        sha256: result.sha256,
        modifiedAt: item.modifiedAt,
      });
      return { source: item.source, path: item.path, status: "saved", decision };
    } catch (error) {
      // Messages must not carry the signed URL; sinks throw their own text.
      const message = error instanceof Error ? error.message : String(error);
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
      onProgress?.(outcomes.length, queue.length, outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  await checkpointing;
  await persist();

  // The ingest batch goes last: its presence tells HQ every listed file is on disk.
  let batch: string | null = null;
  if (layout.id === "ingest" && sink.keepsRecords && saved.length > 0) {
    const at = now();
    const courses = Object.fromEntries(plans.map((plan) => [plan.folder, plan.courseId]));
    const name = batchFileName(at);
    await sink.writeText(["_batches", name], `${JSON.stringify(buildBatch(at, saved, courses), null, 2)}\n`);
    batch = name;
  }

  const count = (status: ItemOutcome["status"]) => outcomes.filter((o) => o.status === status).length;
  return {
    saved: count("saved"),
    unchanged: count("unchanged"),
    failed: count("failed"),
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
