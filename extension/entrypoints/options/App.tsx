/**
 * Settings: the opt-in due.json sync.
 *
 * Off by default. Turning it on asks Chrome for access to api.github.com (an
 * optional host permission, so nobody who never enables this is prompted).
 * The token lives in chrome.storage.local on this machine and is sent only to
 * GitHub, only in the Authorization header.
 */

import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, validate, type SyncSettings } from "@/src/sync/github";
import { loadSettings, loadStatus, saveSettings, type SyncStatus } from "@/src/sync/settings";

const GITHUB = ["https://api.github.com/*"];
const input = "mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600";
const button =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

export default function App() {
  const [settings, setSettings] = useState<SyncSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadStatus().then(setStatus);
  }, []);

  const save = async (next: SyncSettings) => {
    setNote(null);
    if (next.enabled) {
      const problem = validate(next);
      if (problem) return setNote(problem);
      const granted = await chrome.permissions.request({ origins: GITHUB });
      if (!granted) return setNote("Chrome did not grant access to GitHub, so sync stays off.");
    }
    await saveSettings(next);
    setSettings(next);
    setNote(next.enabled ? "Saved. Sync runs about every 2 hours while Chrome is open." : "Saved. Sync is off.");
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
      setStatus(await loadStatus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="mt-6">
        <h2 className="font-medium">Send deadlines to HQ</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Off by default. When on, about every 2 hours the extension writes one file listing your upcoming deadlines
          (course, title, due time, link, done or not) to the GitHub repository below. Nothing else is sent: no grades,
          no files, no course content. Your morning plan reads that file.
        </p>
        <label className="mt-3 block text-sm">
          Repository
          <input className={input} value={settings.repo} onChange={(e) => setSettings({ ...settings, repo: e.target.value.trim() })} />
        </label>
        <label className="mt-3 block text-sm">
          File
          <input className={input} value={settings.path} onChange={(e) => setSettings({ ...settings, path: e.target.value.trim() })} />
        </label>
        <label className="mt-3 block text-sm">
          Token (fine-grained, this one repository, Contents: read and write)
          <input
            className={input}
            type="password"
            autoComplete="off"
            value={settings.token}
            onChange={(e) => setSettings({ ...settings, token: e.target.value.trim() })}
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className={button} onClick={() => save({ ...settings, enabled: true })}>
            {settings.enabled ? "Save" : "Turn on sync"}
          </button>
          {settings.enabled && (
            <>
              <button type="button" className={button} disabled={busy} onClick={syncNow}>Sync now</button>
              <button type="button" className="text-sm underline" onClick={() => save({ ...settings, enabled: false })}>Turn off</button>
            </>
          )}
        </div>
        {note && <p role="status" className="mt-3 text-sm">{note}</p>}
        {status && (
          <p className={`mt-2 text-sm ${status.ok ? "" : "text-red-600 dark:text-red-400"}`}>
            Last sync {new Date(status.at).toLocaleString()}: {status.message}
          </p>
        )}
      </section>
    </div>
  );
}
