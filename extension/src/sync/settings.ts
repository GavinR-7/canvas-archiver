import { DEFAULT_SETTINGS, type SyncSettings } from "./github";

const KEY = "sync.settings";
const STATUS_KEY = "sync.status";

export interface SyncStatus {
  at: string;
  ok: boolean;
  message: string;
}

export async function loadSettings(): Promise<SyncSettings> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<SyncSettings> | undefined;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = (settings: SyncSettings) => chrome.storage.local.set({ [KEY]: settings });

export async function loadStatus(): Promise<SyncStatus | null> {
  return ((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] as SyncStatus | undefined) ?? null;
}

export const saveStatus = (status: SyncStatus) => chrome.storage.local.set({ [STATUS_KEY]: status });
