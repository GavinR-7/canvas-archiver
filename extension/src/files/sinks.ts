/**
 * The two places files can go. Both are thin; the logic worth testing lives in
 * `plan.ts` and `runner.ts`. Not exercised by unit tests: they need a browser.
 */

import { CANVAS_ORIGINS } from "@/src/config/canvas";
import type { FileSink } from "./runner";

// --- Folder sink: File System Access API ---------------------------------

async function directoryFor(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

/**
 * Writes beneath a directory the user picked.
 *
 * Bytes are fetched with `credentials: "omit"`: the URL Canvas issued carries
 * its own verifier, so no cookie is needed, and omitting them guarantees the
 * session cannot travel to whatever CDN the redirect lands on.
 */
export function folderSink(root: FileSystemDirectoryHandle): FileSink {
  return {
    async has(path, size) {
      try {
        const dir = await directoryFor(root, path.slice(0, -1), false);
        const handle = await dir.getFileHandle(path[path.length - 1] as string);
        return (await handle.getFile()).size === size;
      } catch {
        return false; // not found (or a folder in the way): write it
      }
    },

    async save(file) {
      let response: Response;
      try {
        response = await fetch(file.url, { credentials: "omit", redirect: "follow" });
      } catch {
        // A bare TypeError: network failure or the host refusing a cross-origin read.
        throw new Error("blocked: the file host did not allow the browser to read this file");
      }
      if (!response.ok || !response.body) throw new Error(`Canvas answered ${response.status}`);

      const dir = await directoryFor(root, file.path.slice(0, -1), true);
      const handle = await dir.getFileHandle(file.path[file.path.length - 1] as string, { create: true });
      // createWritable stages to a swap file and commits on close, so an
      // interrupted write never leaves a half file under the real name.
      const writable = await handle.createWritable();
      try {
        await response.body.pipeTo(writable);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },
  };
}

// --- Fallback sink: chrome.downloads, under Downloads/ -------------------

/**
 * Hands the URL to the browser's own downloader. Lands under the default
 * Downloads folder (an extension cannot change that), keeping the planned
 * relative path. `has` is always false: this sink cannot see the disk.
 */
export function downloadsSink(): FileSink {
  return {
    has: async () => false,
    async save(file) {
      const url = new URL(file.url);
      if (!CANVAS_ORIGINS.some((origin) => new URL(origin).origin === url.origin)) {
        throw new Error("Refusing to download from a host that is not Canvas");
      }
      const id = await chrome.downloads.download({
        url: file.url,
        filename: file.path.join("/"),
        conflictAction: "uniquify",
      });
      if (id === undefined) throw new Error(chrome.runtime.lastError?.message ?? "Download did not start");
    },
  };
}
