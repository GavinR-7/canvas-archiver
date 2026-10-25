/**
 * Runs a download plan against a "sink" (somewhere files can be written).
 *
 * The sink is an interface so the runner is tested without a browser, and so
 * the folder sink (File System Access API) and the Downloads fallback
 * (`chrome.downloads`) share one loop. Per-file failures are recorded and the
 * run continues: one locked file must not abandon four hundred others.
 */

import type { PlannedFile } from "./plan";

export interface FileSink {
  /** Is this exact file (same path, same size) already there? */
  has(path: string[], size: number): Promise<boolean>;
  /**
   * Fetch `file.url` and store it at `file.path`.
   * Sinks that fetch bytes themselves must send no cookies to the file host.
   */
  save(file: PlannedFile): Promise<void>;
}

export type FileOutcome =
  | { fileId: number; path: string[]; status: "saved" }
  | { fileId: number; path: string[]; status: "skipped" }
  | { fileId: number; path: string[]; status: "failed"; message: string };

export interface RunResult {
  saved: number;
  skipped: number;
  failed: number;
  outcomes: FileOutcome[];
  cancelled: boolean;
}

export interface RunOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, last: FileOutcome) => void;
}

export async function runPlan(
  files: PlannedFile[],
  sink: FileSink,
  { concurrency = 3, signal, onProgress }: RunOptions = {},
): Promise<RunResult> {
  const outcomes: FileOutcome[] = [];
  let next = 0;

  const one = async (file: PlannedFile): Promise<FileOutcome> => {
    try {
      if (await sink.has(file.path, file.size)) {
        return { fileId: file.fileId, path: file.path, status: "skipped" };
      }
      await sink.save(file);
      return { fileId: file.fileId, path: file.path, status: "saved" };
    } catch (error) {
      // Messages must not carry the signed URL; sinks throw their own text.
      const message = error instanceof Error ? error.message : String(error);
      return { fileId: file.fileId, path: file.path, status: "failed", message };
    }
  };

  const worker = async () => {
    while (!signal?.aborted) {
      const file = files[next++];
      if (!file) return;
      const outcome = await one(file);
      outcomes.push(outcome);
      onProgress?.(outcomes.length, files.length, outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const count = (status: FileOutcome["status"]) => outcomes.filter((o) => o.status === status).length;
  return {
    saved: count("saved"),
    skipped: count("skipped"),
    failed: count("failed"),
    outcomes,
    cancelled: signal?.aborted ?? false,
  };
}

/**
 * Did every failure look like the file host refusing a cross-origin read?
 * `fetch` reports that as a bare TypeError with no status, which the sink
 * surfaces as "blocked". If nothing was saved and all failures are that, the
 * UI offers the Downloads-folder fallback.
 */
export function looksBlockedByCors(result: RunResult): boolean {
  return (
    result.saved === 0 &&
    result.failed > 0 &&
    result.outcomes.every((o) => o.status !== "failed" || o.message.startsWith("blocked:"))
  );
}
