/**
 * React binding for the service worker's snapshot.
 *
 * Both the popup and the Upcoming page need the same data and the same
 * loading/error handling, so it lives here rather than being written twice.
 */

import { useCallback, useEffect, useState } from "react";
import { EMPTY_SNAPSHOT, sendMessage, type Snapshot } from "@/src/lib/messages";

export interface SnapshotState {
  snapshot: Snapshot;
  /** True during the very first load, when there is nothing to show yet. */
  loading: boolean;
  /** True during a refresh that has existing data to fall back on. */
  refreshing: boolean;
  refresh: () => void;
}

export function useSnapshot(): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    try {
      setSnapshot(await sendMessage({ type: force ? "REFRESH" : "GET_SNAPSHOT" }));
    } catch (error) {
      setSnapshot((previous) => ({
        ...previous,
        error: { kind: "other", message: String(error) },
      }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

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
