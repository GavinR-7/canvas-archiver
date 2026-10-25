/**
 * Getting one file's bytes from the host, with the ways around a host that
 * will not let an extension page read it.
 *
 * Canvas hands out a download URL that redirects to a file host. A direct
 * `fetch` from the extension can fail there with a bare TypeError (the host
 * sends no CORS headers, or refuses the redirect), which the browser reports
 * the same way as being offline. In order:
 *
 *  1. `fetch` with no credentials: the URL carries its own verifier. Most files.
 *  2. `fetch` with the Canvas session, only toward the Canvas origin (checked).
 *     For a verifier Canvas no longer honours; the host redirect problem remains.
 *  3. The browser's own downloader (`chrome.downloads`), which is not bound by
 *     CORS and sends the user's cookies itself. It can only write below the
 *     Downloads folder, so the file lands at `Downloads/<planned path>` instead
 *     of the chosen folder, and the manifest says so (`method: "downloads"`).
 *
 * 429/502/503/504 are retried a few times with backoff on 1 and 2. Nothing is
 * skipped quietly: a file that still cannot be fetched fails with a message.
 * Pure over injected `fetch`, `download` and `sleep`, so it is tested without a browser.
 */

import { assertCanvasOrigin } from "@/src/canvas/url-guard";
import type { PlannedItem } from "./plan";

export type Method = "fetch" | "fetch-session" | "downloads";

export interface TransferDeps {
  fetch: typeof fetch;
  /** Hands the URL to the browser's downloader and resolves when it has finished; returns the size and where it landed. */
  download: ((url: string, filename: string) => Promise<Downloaded>) | null;
  sleep: (ms: number) => Promise<void>;
  /** Origin the session may be sent to. */
  canvasOrigin?: string;
}

export interface Downloaded {
  size: number;
  /** Path under the Downloads folder the file was actually written to (a name clash gets "(1)" appended, never overwritten). */
  savedTo: string;
}

export type Acquired =
  | { how: "stream"; response: Response; method: "fetch" | "fetch-session" }
  | { how: "downloaded"; size: number; savedTo: string; method: "downloads" };

/** Strip anything URL-shaped from text that may reach the screen, the manifest or a log: a signed address carries its secret in the query. */
export function scrubUrls(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[address removed]")
    .replace(/[?&](verifier|token|access_token|signature|sig|key|jwt|download_frd)=[^\s&"')]*/gi, "[removed]")
    .replace(/\?[^\s"')]*=[^\s"')]*/g, "[removed]");
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
export const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 400;

const label = (system: PlannedItem["session"]) => (system === "gradescope" ? "Gradescope" : "Canvas");

/** One request with bounded retries on throttle and gateway errors. A network failure is thrown, not retried. */
async function attempt(deps: TransferDeps, url: string, init: RequestInit): Promise<Response> {
  for (let n = 1; ; n++) {
    const response = await deps.fetch(url, init);
    if (!RETRY_STATUSES.has(response.status) || n >= MAX_ATTEMPTS) return response;
    await response.body?.cancel().catch(() => undefined);
    await deps.sleep(BACKOFF_MS * 2 ** (n - 1) * (0.75 + Math.random() * 0.5));
  }
}

/**
 * Fetch a Canvas file. Throws only when every route failed; the message names
 * what was tried and never carries the signed URL.
 */
export async function acquireCanvasFile(item: PlannedItem, deps: TransferDeps, allowDownloads: boolean): Promise<Acquired> {
  const url = item.url as string;
  let blocked = false;
  let status = 0;

  try {
    const response = await attempt(deps, url, { credentials: "omit", redirect: "follow" });
    if (response.ok && response.body) return { how: "stream", response, method: "fetch" };
    status = response.status;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    blocked = true;
  }

  let sessionOrigin = false;
  try {
    assertCanvasOrigin(url, deps.canvasOrigin);
    sessionOrigin = true;
  } catch {
    // Not the Canvas origin: the session must not go there.
  }
  if (sessionOrigin) {
    try {
      const response = await attempt(deps, url, { method: "GET", credentials: "include", redirect: "follow" });
      if (response.ok && response.body) return { how: "stream", response, method: "fetch-session" };
      status = response.status;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      blocked = true;
    }
  }

  if (allowDownloads && deps.download) {
    try {
      const got = await deps.download(url, item.path.join("/"));
      return { how: "downloaded", size: got.size, savedTo: got.savedTo, method: "downloads" };
    } catch (error) {
      const why = scrubUrls(error instanceof Error ? error.message : String(error));
      throw new Error(`${blocked ? "blocked" : `${label(item.session)} answered ${status}`}: the browser download also failed (${why})`);
    }
  }
  throw new Error(
    blocked
      ? "blocked: the file host did not allow the browser to read this file"
      : `${label(item.session)} answered ${status || "no usable response"}`,
  );
}

/** "C:\\Users\\g\\Downloads\\Cornell\\CS 3700\\a (1).pdf" -> "Cornell/CS 3700/a (1).pdf"; falls back to the planned name. */
export function downloadsRelative(absolute: string | undefined, planned: string): string {
  const parts = (absolute ?? "").replace(/\\/g, "/").split("/");
  const at = parts.lastIndexOf("Downloads");
  return at >= 0 && at < parts.length - 1 ? parts.slice(at + 1).join("/") : planned;
}

/**
 * The real downloader: starts the download, waits for it to finish, returns the bytes
 * written and where they landed. A clash with an existing file is renamed, never overwritten.
 * The browser's history record (which holds the signed address) is erased on every exit.
 */
export function browserDownload(timeoutMs = 10 * 60_000): (url: string, filename: string) => Promise<Downloaded> {
  return (url, filename) =>
    new Promise<Downloaded>((resolve, reject) => {
      let id: number | undefined;
      const timer = setTimeout(() => done(new Error("timed out")), timeoutMs);
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id) return;
        if (delta.state?.current === "complete") {
          void chrome.downloads.search({ id }).then((found) => done(null, { size: found[0]?.fileSize ?? 0, savedTo: downloadsRelative(found[0]?.filename, filename) }));
        } else if (delta.state?.current === "interrupted" || delta.error) {
          done(new Error(delta.error?.current ?? "interrupted"));
        }
      };
      const done = (error: Error | null, got?: Downloaded) => {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        // Remove the history record (not the file): it holds the signed address.
        if (id !== undefined) void chrome.downloads.erase({ id }).catch(() => undefined);
        if (error) reject(new Error(scrubUrls(error.message)));
        else resolve(got as Downloaded);
      };
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads
        .download({ url, filename, conflictAction: "uniquify" })
        .then((started) => {
          if (started === undefined) return done(new Error(chrome.runtime.lastError?.message ?? "did not start"));
          id = started;
          // It may have finished before we knew its id.
          return chrome.downloads.search({ id }).then(([found]) => {
            if (found?.state === "complete") done(null, { size: found.fileSize, savedTo: downloadsRelative(found.filename, filename) });
            else if (found?.state === "interrupted") done(new Error(found.error ?? "interrupted"));
          });
        })
        .catch((error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
    });
}
