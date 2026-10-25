/**
 * The places files can go, and where manifests are kept. All thin; the logic
 * worth testing lives in `plan.ts`, `manifest.ts` and `runner.ts`. Not
 * exercised by unit tests: they need a browser.
 */

import { assertCanvasOrigin } from "@/src/canvas/url-guard";
import { CANVAS_ORIGINS } from "@/src/config/canvas";
import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import { emptyManifest, MANIFEST_FILE, parseManifest, type CourseManifest } from "./manifest";
import type { FileSink, ManifestStore } from "./runner";
import { Sha256 } from "./sha256";

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

async function fileHandle(root: FileSystemDirectoryHandle, path: string[], create: boolean) {
  const dir = await directoryFor(root, path.slice(0, -1), create);
  return dir.getFileHandle(path[path.length - 1] as string, { create });
}

const encoder = new TextEncoder();

/**
 * Writes beneath a directory the user picked.
 *
 * Bytes are fetched with `credentials: "omit"`: the URL Canvas issued carries
 * its own verifier, so no cookie is needed, and omitting them guarantees the
 * session cannot travel to whatever CDN the redirect lands on. The body is
 * tee'd through SHA-256 on its way to disk, so the hash is of what was written.
 */
export function folderSink(root: FileSystemDirectoryHandle): FileSink {
  return {
    keepsRecords: true,

    async size(path) {
      try {
        return (await (await fileHandle(root, path, false)).getFile()).size;
      } catch {
        return null; // not found (or a folder in the way)
      }
    },

    async readText(path) {
      try {
        return await (await (await fileHandle(root, path, false)).getFile()).text();
      } catch {
        return null;
      }
    },

    async writeText(path, text) {
      const writable = await (await fileHandle(root, path, true)).createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },

    async save(item) {
      const hash = new Sha256();
      let size = 0;
      let body: ReadableStream<Uint8Array>;

      if (item.content !== null) {
        const bytes = encoder.encode(item.content);
        hash.update(bytes);
        size = bytes.length;
        body = new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
      } else {
        let response: Response;
        // Gradescope files need the signed-in session, so the origin is checked first:
        // the cookie only ever goes to Gradescope (GET, read-only).
        if (item.session === "gradescope") assertCanvasOrigin(item.url as string, GRADESCOPE_ORIGIN);
        try {
          response = await fetch(
            item.url as string,
            item.session === "gradescope"
              ? { method: "GET", credentials: "include", redirect: "follow" }
              : { credentials: "omit", redirect: "follow" },
          );
        } catch {
          // A bare TypeError: network failure or the host refusing a cross-origin read.
          throw new Error("blocked: the file host did not allow the browser to read this file");
        }
        if (item.session === "gradescope" && response.redirected && /\/(login|saml)\b/.test(new URL(response.url).pathname)) {
          throw new Error("Gradescope session expired: sign in to Gradescope and run again");
        }
        if (!response.ok || !response.body) {
          throw new Error(`${item.session === "gradescope" ? "Gradescope" : "Canvas"} answered ${response.status}`);
        }
        body = response.body;
      }

      const handle = await fileHandle(root, item.path, true);
      // createWritable stages to a swap file and commits on close, so an
      // interrupted write never leaves a half file under the real name.
      const writable = await handle.createWritable();
      try {
        const counted =
          item.content !== null
            ? body
            : body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    hash.update(chunk);
                    size += chunk.length;
                    controller.enqueue(chunk);
                  },
                }),
              );
        await counted.pipeTo(writable);
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      return { size, sha256: hash.digest() };
    },
  };
}

// --- Fallback sink: chrome.downloads, under Downloads/ -------------------

/**
 * Hands the URL to the browser's own downloader. Lands under the default
 * Downloads folder (an extension cannot change that), keeping the planned
 * relative path. It cannot see the disk, hash, or keep a manifest, so every
 * run saves everything again (`keepsRecords` false).
 */
export function downloadsSink(): FileSink {
  return {
    keepsRecords: false,
    size: async () => null,
    readText: async () => null,
    writeText: async () => {
      throw new Error("The Downloads fallback cannot write manifests");
    },
    async save(item) {
      let url: string;
      if (item.session) throw new Error("Gradescope files need the folder option; the Downloads fallback cannot use your Gradescope session");
      if (item.content !== null) {
        url = `data:text/html;charset=utf-8,${encodeURIComponent(item.content)}`;
      } else {
        url = item.url as string;
        const origin = new URL(url).origin;
        if (!CANVAS_ORIGINS.some((allowed) => new URL(allowed).origin === origin)) {
          throw new Error("Refusing to download from a host that is not Canvas");
        }
      }
      const id = await chrome.downloads.download({
        url,
        filename: item.path.join("/"),
        conflictAction: "uniquify",
      });
      if (id === undefined) throw new Error(chrome.runtime.lastError?.message ?? "Download did not start");
      return { size: item.size, sha256: null };
    },
  };
}

// --- Manifest stores ------------------------------------------------------

/** Archive layout: `.canvas-archive.json` in the course folder, next to the data it describes. */
export function folderManifestStore(sink: FileSink): ManifestStore {
  return {
    async load(plan) {
      return parseManifest(await sink.readText([...plan.dir, MANIFEST_FILE]), plan.courseId);
    },
    async save(plan, manifest) {
      await sink.writeText([...plan.dir, MANIFEST_FILE], `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

const STORAGE_PREFIX = "archiveManifest:";

/**
 * Ingest layout: HQ's nightly job drains the inbox, so "what was already
 * saved" cannot be read back from it. It lives in extension storage instead.
 */
export function storageManifestStore(): ManifestStore {
  return {
    async load(plan) {
      const key = `${STORAGE_PREFIX}ingest:${plan.courseId}`;
      const stored = (await chrome.storage.local.get(key))[key] as CourseManifest | undefined;
      return stored ? parseManifest(JSON.stringify(stored), plan.courseId) : emptyManifest(plan.courseId);
    },
    async save(plan, manifest) {
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}ingest:${plan.courseId}`]: manifest });
    },
  };
}
