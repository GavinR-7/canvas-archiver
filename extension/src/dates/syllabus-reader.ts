/**
 * The browser side of `syllabus-files.ts`: list a course's syllabus files from
 * Canvas, read their bytes, pull the text out of a PDF.
 *
 * The PDF library is loaded only when a PDF actually has to be read (it is the
 * largest dependency), and it ships inside the extension: nothing is fetched
 * from a CDN. Runs in the background worker, which has no DOM.
 */

import { getAll, getOne } from "@/src/canvas/client";
import { AccessDeniedError, NotFoundError } from "@/src/canvas/errors";
import { acquireCanvasFile } from "@/src/files/transfer";
import { fileIdsIn } from "@/src/files/attachments";
import { normalizeFile } from "@/src/files/api";
import type { DateCandidate } from "./extract";
import type { SyllabusFile, SyllabusFileDeps } from "./syllabus-files";

const CACHE_KEY = "syllabus-files.v1";
const MAX_BYTES = 25 * 1024 * 1024;

type Raw = Record<string, unknown>;

async function asFile(id: number, courseId: number): Promise<SyllabusFile | null> {
  for (const path of [`/courses/${courseId}/files/${id}`, `/files/${id}`]) {
    try {
      const file = normalizeFile(await getOne<Raw>(path));
      if (file) return { id: file.id, name: file.displayName, updatedAt: file.updatedAt, url: file.url };
    } catch (error) {
      if (!(error instanceof AccessDeniedError || error instanceof NotFoundError)) throw error;
    }
  }
  return null;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n");
}

export function browserSyllabusDeps(): SyllabusFileDeps {
  return {
    async listFiles(course) {
      const ids = new Set<number>();
      try {
        const raw = await getOne<Raw>(`/courses/${course.id}`, { "include[]": ["syllabus_body"] });
        for (const id of fileIdsIn(typeof raw["syllabus_body"] === "string" ? raw["syllabus_body"] : "")) ids.add(id);
      } catch (error) {
        if (!(error instanceof AccessDeniedError || error instanceof NotFoundError)) throw error;
      }
      const found: SyllabusFile[] = [];
      try {
        for (const raw of await getAll<Raw>(`/courses/${course.id}/files`, { search_term: "syllabus" }, { maxPages: 2 })) {
          const file = normalizeFile(raw);
          if (file) {
            ids.delete(file.id);
            found.push({ id: file.id, name: file.displayName, updatedAt: file.updatedAt, url: file.url });
          }
        }
      } catch (error) {
        if (!(error instanceof AccessDeniedError || error instanceof NotFoundError)) throw error;
      }
      for (const id of ids) {
        const file = await asFile(id, course.id);
        if (file) found.push(file);
      }
      return found;
    },

    async readText(file) {
      if (!file.url) return null;
      const got = await acquireCanvasFile(
        { source: `canvas:file/${file.id}`, courseId: 0, path: [file.name], size: 0, modifiedAt: file.updatedAt, url: file.url, content: null },
        { fetch: (input, init) => fetch(input, init), download: null, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        false,
      );
      if (got.how !== "stream") return null;
      const buffer = new Uint8Array(await got.response.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) return null;
      if (/\.pdf$/i.test(file.name)) return pdfText(buffer);
      return new TextDecoder().decode(buffer);
    },

    cache: {
      async get(key) {
        const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as Record<string, DateCandidate[]> | undefined;
        return stored?.[key];
      },
      async set(key, value) {
        const stored = ((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as Record<string, DateCandidate[]> | undefined) ?? {};
        await chrome.storage.local.set({ [CACHE_KEY]: { ...stored, [key]: value } });
      },
    },
  };
}
