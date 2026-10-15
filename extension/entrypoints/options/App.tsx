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
import { DEFAULT_AI, loadAi, saveAi, type AiSettings } from "@/src/ai/model";
import { INBOX_KEY, loadRoot, pickRoot, requestRootAccess, rootAccess, saveRoot, type RootAccess } from "@/src/files/handle-store";
import { DEFAULT_FEED, loadFeed, loadFeedStatus, saveFeed, type FeedSettings, type FeedStatus } from "@/src/feed/settings";
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

  const [feed, setFeed] = useState<FeedSettings>(DEFAULT_FEED);
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [inbox, setInbox] = useState<FileSystemDirectoryHandle | null>(null);
  const [inboxAccess, setInboxAccess] = useState<RootAccess>("prompt");
  const [feedNote, setFeedNote] = useState<string | null>(null);

  const [ai, setAi] = useState<AiSettings>(DEFAULT_AI);
  const [aiNote, setAiNote] = useState<string | null>(null);
  useEffect(() => { void loadAi().then(setAi); }, []);
  const saveAiSettings = async (next: AiSettings) => {
    setAiNote(null);
    if (next.enabled) {
      if (!next.apiKey.trim()) return setAiNote("Paste your Anthropic API key first.");
      const granted = await chrome.permissions.request({ origins: ["https://api.anthropic.com/*"] });
      if (!granted) return setAiNote("Chrome did not grant access to api.anthropic.com, so this stays off.");
    }
    await saveAi({ ...next, apiKey: next.apiKey.trim() });
    setAi({ ...next, apiKey: next.apiKey.trim() });
    setAiNote(next.enabled ? "Saved." : "Off.");
  };

  useEffect(() => {
    void loadFeed().then(setFeed);
    void loadFeedStatus().then(setFeedStatus);
    void loadRoot(INBOX_KEY).then(async (h) => {
      setInbox(h);
      if (h) setInboxAccess(await rootAccess(h));
    });
  }, []);

  const chooseInbox = async () => {
    setFeedNote(null);
    try {
      const handle = await pickRoot("hq-inbox");
      await saveRoot(handle, INBOX_KEY);
      setInbox(handle);
      setInboxAccess(await requestRootAccess(handle));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setFeedNote(`Chrome would not use that folder: ${(error as Error).message}`);
    }
  };

  const reconnectInbox = async () => {
    if (inbox) setInboxAccess(await requestRootAccess(inbox));
  };

  const setFeedEnabled = async (enabled: boolean) => {
    if (enabled && (!inbox || inboxAccess !== "granted")) return setFeedNote("Choose the inbox folder (and allow access) first.");
    const next = { ...feed, enabled };
    await saveFeed(next);
    setFeed(next);
    setFeedNote(enabled ? `On. Runs about ${String(next.hour).padStart(2, "0")}:00 each night while Chrome is open.` : "Off.");
  };

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

      <section className="mt-10">
        <h2 className="font-medium">Nightly feed to HQ course knowledge</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Off by default. When on, each night the extension saves new or changed course files into a folder you choose
          (HQ's course inbox). HQ's own nightly job then files them. Nothing is uploaded anywhere. Chrome has to be open at that
          time, and it has to still have your permission for the folder (choose "Allow on every visit" if Chrome asks).
        </p>
        <p className="mt-2 text-sm">
          Inbox folder: <strong>{inbox ? inbox.name : "none chosen"}</strong>{" "}
          {inbox && inboxAccess !== "granted" && (
            <button type="button" className="underline underline-offset-2" onClick={reconnectInbox}>Reconnect</button>
          )}{" "}
          <button type="button" className="underline underline-offset-2" onClick={chooseInbox}>{inbox ? "Change" : "Choose folder"}</button>
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={feed.enabled} onChange={(e) => void setFeedEnabled(e.target.checked)} />
          Send new course files to HQ every night
        </label>
        {feedNote && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{feedNote}</p>}
        {feedStatus && (
          <p className={`mt-2 text-sm ${feedStatus.ok ? "" : "text-red-600 dark:text-red-400"}`}>
            Last run {new Date(feedStatus.at).toLocaleString()}: {feedStatus.message}
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-medium">AI file picker (your own API key)</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Off by default. "Get everything for prelim 2" uses plain rules first. If they find nothing, and this is on, the
          course's folder and file <em>names</em> (never file contents) are sent to Anthropic with your key so a model can choose.
          The key stays in this browser and is sent only to api.anthropic.com.
        </p>
        <label className="mt-3 block text-sm">
          API key
          <input type="password" autoComplete="off" className={input} value={ai.apiKey} onChange={(e) => setAi({ ...ai, apiKey: e.target.value })} placeholder="sk-ant-…" />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ai.enabled} onChange={(e) => void saveAiSettings({ ...ai, enabled: e.target.checked })} />
          Let a model choose files when the rules find nothing
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ai.allowContent} onChange={(e) => void saveAiSettings({ ...ai, allowContent: e.target.checked })} />
          Course chat: send the few matching passages of course text with each question
        </label>
        <button type="button" className="mt-2 text-sm underline" onClick={() => void saveAiSettings(ai)}>Save key</button>
        {aiNote && <p className="mt-2 text-sm">{aiNote}</p>}
      </section>
    </div>
  );
}
