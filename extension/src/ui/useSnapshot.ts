/**
 * React binding for the service worker's snapshot.
 *
 * Both the popup and the Upcoming page need the same data and the same
 * loading/error handling, so it lives here rather than being written twice.
 */

import { useCallback, useEffect, useState } from "react";
import { EMPTY_SNAPSHOT, sendMessage, type Snapshot } from "@/src/lib/messages";
import { loadSnapshot } from "@/src/lib/storage";

export interface SnapshotState {
  snapshot: Snapshot;
  /** True during the very first load, when there is nothing to show yet. */
  loading: boolean;
  /** True during a refresh that has existing data to fall back on. */
  refreshing: boolean;
  refresh: () => void;
}

/**
 * `network` asks the worker, which refreshes from Canvas when the cache is empty or stale (and on an explicit refresh).
 * `cache` only reads what is stored and never sends a request, and its refresh does nothing. `wait` loads nothing yet.
 */
export type SnapshotMode = "network" | "cache" | "wait";

/** The one place that decides whether a read may reach the network. null means "load nothing yet". */
export async function readSnapshot(
  mode: SnapshotMode,
  force: boolean,
  io: { cached: () => Promise<Snapshot>; ask: (type: "GET_SNAPSHOT" | "REFRESH") => Promise<Snapshot> },
): Promise<Snapshot | null> {
  if (mode === "wait" || (mode === "cache" && force)) return null;
  return mode === "cache" ? io.cached() : io.ask(force ? "REFRESH" : "GET_SNAPSHOT");
}

export function useSnapshot(mode: SnapshotMode = "network"): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback(async (force: boolean) => {
    if (mode === "wait" || (mode === "cache" && force)) return;
    if (force) setRefreshing(true);
    try {
      const read = await readSnapshot(mode, force, { cached: loadSnapshot, ask: (type) => sendMessage({ type }) });
      if (read) setSnapshot(read);
    } catch (error) {
      setSnapshot((previous) => ({
        ...previous,
        error: { kind: "other", message: String(error) },
      }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [mode]);

  useEffect(() => {
    void run(false);
  }, [run]);

  return {
    snapshot,
    loading,
    refreshing,
    refresh: useCallback(() => void run(true), [run]),
  };
}
