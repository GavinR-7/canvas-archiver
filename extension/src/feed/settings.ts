/**
 * Nightly feed into HQ's course knowledge. Opt-in; the inbox folder handle
 * lives in IndexedDB (see handle-store), the on/off switch and last result
 * here. Nothing is sent anywhere: files are written to a folder on this machine.
 */

const KEY = "feed.settings";
const STATUS_KEY = "feed.status";

export interface FeedSettings {
  enabled: boolean;
  /** Local hour of day to run, 0-23. */
  hour: number;
}

export const DEFAULT_FEED: FeedSettings = { enabled: false, hour: 2 };

export interface FeedStatus {
  at: string;
  ok: boolean;
  message: string;
}

export async function loadFeed(): Promise<FeedSettings> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<FeedSettings> | undefined;
    const hour = Number.isInteger(stored?.hour) && (stored?.hour as number) >= 0 && (stored?.hour as number) <= 23 ? (stored?.hour as number) : DEFAULT_FEED.hour;
    return { enabled: stored?.enabled === true, hour };
  } catch {
    return DEFAULT_FEED;
  }
}

export const saveFeed = (settings: FeedSettings) => chrome.storage.local.set({ [KEY]: settings });

export async function loadFeedStatus(): Promise<FeedStatus | null> {
  return ((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] as FeedStatus | undefined) ?? null;
}

export const saveFeedStatus = (status: FeedStatus) => chrome.storage.local.set({ [STATUS_KEY]: status });

/** Minutes from `now` until the next local `hour`:00 (always in the future). */
export function minutesUntilHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime() + 60_000) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000));
}
