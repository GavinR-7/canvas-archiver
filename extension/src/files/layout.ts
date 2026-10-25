/**
 * Where things go. Two profiles over the same plan.
 *
 * `archive`: for a person browsing their own folder. `Cornell/<course>/…`,
 *   readable names, Canvas's folder structure kept for loose files, and a
 *   manifest kept in the folder next to the data.
 *
 * `ingest`: the contract in `knowledge/courses/README.md`. `<course-slug>/…`
 *   with `NN-module-slug` folders, a flat `files/` for everything outside a
 *   module, `_syllabus/`, and a `_batches/<ISO>.json` written last. HQ's nightly
 *   job drains the inbox, so the incremental state cannot live there; it is
 *   kept in extension storage instead.
 */

import type { Course } from "@/src/types/canvas";
import { courseFolderName, ROOT_FOLDER, sanitizeFilename, sanitizeSegment, slugify } from "./paths";
import type { CanvasDocument, CanvasModule } from "./plan";

export interface Layout {
  id: "archive" | "ingest";
  /** Re-check that a "known" file still exists on disk before skipping it. */
  verifyDisk: boolean;
  /** Needs the folder sink (hashes, text files). Not available through chrome.downloads. */
  needsFolder: boolean;
  courseName(course: Pick<Course, "name" | "courseCode">): string;
  /** The `n`th (n >= 2) alternative to a course folder name that is already taken. */
  numberedCourseName(name: string, n: number): string;
  courseDir(courseName: string): string[];
  moduleDir(courseDir: string[], module: Pick<CanvasModule, "name" | "position">): string[];
  looseDir(courseDir: string[], canvasFolders: string[]): string[];
  documentDir(courseDir: string[], kind: Exclude<CanvasDocument["kind"], "syllabus">): string[];
  syllabusDir(courseDir: string[]): string[];
  externalDir(courseDir: string[], system: "gradescope"): string[];
  documentName(doc: CanvasDocument): string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const KIND_FOLDER = { page: "Pages", assignment: "Assignments", announcement: "Announcements" } as const;

/** `2026-10-14T12:00:00Z` → `2026-10-14`, or "" */
const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");

export const archiveLayout: Layout = {
  id: "archive",
  verifyDisk: true,
  needsFolder: false,
  courseName: courseFolderName,
  numberedCourseName: (name, n) => `${name} (${n})`,
  courseDir: (name) => [ROOT_FOLDER, name],
  moduleDir: (dir, module) => [...dir, sanitizeSegment(`${pad(module.position)} ${module.name}`, `${pad(module.position)} Module`)],
  looseDir: (dir, folders) => [...dir, "Course files", ...folders],
  documentDir: (dir, kind) => [...dir, KIND_FOLDER[kind]],
  syllabusDir: (dir) => [...dir, "Syllabus"],
  externalDir: (dir) => [...dir, "Gradescope"],
  documentName: (doc) => sanitizeFilename(`${doc.title || doc.kind}.html`, `${doc.kind}.html`),
};

/**
 * The contract's course folder is the lowercase department + number with no
 * space ("ece3030"), even when Canvas says "ECE 3030 FA26" or "ECE3030-001".
 * Anything that does not look like that falls back to a plain slug.
 */
export function ingestCourseSlug(course: Pick<Course, "name" | "courseCode">): string {
  for (const text of [course.courseCode, course.name]) {
    const match = /\b([A-Za-z]{2,5})[\s-]?(\d{4})\b/.exec(text ?? "");
    if (match) return `${match[1]}${match[2]}`.toLowerCase();
  }
  return slugify(course.courseCode || course.name, "course").replace(/-/g, "");
}

export const ingestLayout: Layout = {
  id: "ingest",
  verifyDisk: false,
  needsFolder: true,
  courseName: (course) => ingestCourseSlug(course),
  numberedCourseName: (name, n) => `${name}-${n}`,
  courseDir: (slug) => [slug],
  moduleDir: (dir, module) => [...dir, `${pad(module.position)}-${slugify(module.name, "module")}`],
  looseDir: (dir) => [...dir, "files"],
  documentDir: (dir) => [...dir, "files"],
  syllabusDir: (dir) => [...dir, "_syllabus"],
  externalDir: (dir) => [...dir, "files"],
  documentName: (doc) => {
    const stamp = doc.kind === "announcement" ? `${day(doc.modifiedAt)}-` : "";
    return `${doc.kind}-${stamp}${slugify(doc.title, doc.key)}.html`;
  },
};

export const layouts = { archive: archiveLayout, ingest: ingestLayout } as const;
