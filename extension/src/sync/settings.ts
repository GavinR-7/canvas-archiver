import { DEFAULT_SETTINGS, type SyncSettings } from "./github";

const KEY = "sync.settings";
const STATUS_KEY = "sync.status";

export interface SyncStatus {
  at: string;
  ok: boolean;
  message: string;
}

/**
 * The token is kept (in chrome.storage.local, documented in PRIVACY.md) only while
 * sync is on. Turning sync off, or clearing the field, removes it from storage.
 */
export const withRetention = (settings: SyncSettings): SyncSettings =>
  settings.enabled && settings.token ? settings : { ...settings, token: "" };

export async function loadSettings(): Promise<SyncSettings> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<SyncSettings> | undefined;
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    // A token left by an earlier version while sync was off goes now, not at the next save.
    if (stored?.token && !stored.enabled) await chrome.storage.local.set({ [KEY]: withRetention(settings) });
    return withRetention(settings);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = (settings: SyncSettings) => chrome.storage.local.set({ [KEY]: withRetention(settings) });

export async function loadStatus(): Promise<SyncStatus | null> {
  return ((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] as SyncStatus | undefined) ?? null;
}

export const saveStatus = (status: SyncStatus) => chrome.storage.local.set({ [STATUS_KEY]: status });
