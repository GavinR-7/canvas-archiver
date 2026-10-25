/**
 * The archive plan: every item to save for a course, and where it goes.
 *
 * Pure. No network and no file system, so the whole layout is unit-tested.
 * Two layouts share one planner (see `layout.ts`):
 *
 *   archive  Cornell/<course>/<NN module>/<file>            (default; for people)
 *   ingest   <course-slug>/<NN-module-slug>/<file>          (HQ's nightly ingest)
 *
 * An item is either a *download* (a Canvas file, fetched by URL) or *inline*
 * (a page, assignment, announcement or syllabus, rendered to an HTML file from
 * text Canvas already returned). Every item has a stable `source` id, like
 * `canvas:file/8841223`; names can change, ids cannot, and the manifest and the
 * ingest ledger both key on it.
 */

import type { Course } from "@/src/types/canvas";
import { archiveLayout, type Layout } from "./layout";
import { courseFolderName, ROOT_FOLDER, sanitizeFilename, sanitizeSegment, uniqueNames } from "./paths";

export { courseFolderName, ROOT_FOLDER };
import { relativeLink } from "./attachments";
import { renderDocument } from "./render";

export interface CanvasFile {
  id: number;
  displayName: string;
  filename: string;
  /** Bytes, as Canvas reports them. */
  size: number;
  updatedAt: string | null;
  /** Download URL Canvas issued. Carries its own verifier; never log or store it. */
  url: string | null;
  folderId: number | null;
  locked: boolean;
}

export interface CanvasFolder {
  id: number;
  /** e.g. `course files/Lectures/Week 1` */
  fullName: string;
}

export interface CanvasModule {
  id: number;
  name: string;
  position: number;
  /** File ids linked from this module, in module order. */
  fileIds: number[];
}

/** A page, assignment, announcement, discussion or syllabus: text we render to HTML. */
export interface CanvasDocument {
  kind: "page" | "assignment" | "announcement" | "discussion" | "syllabus";
  /** Stable key within its kind: page url slug, numeric id, or the course id. */
  key: string;
  title: string;
  html: string;
  modifiedAt: string | null;
  /** Where it lives in Canvas, for the header of the saved file. */
  htmlUrl: string | null;
  /** Canvas file ids it attaches or links, in order. Saved beside it; absent means none. */
  attachmentIds?: number[];
}

/** A file from a system other than Canvas (Gradescope handouts), fetched with that system's session. */
export interface ExternalFile {
  /** Stable id, e.g. `gradescope:file/<assignment>/<key>`. */
  source: string;
  system: "gradescope";
  filename: string;
  url: string;
}

export interface CourseSources {
  modules: CanvasModule[];
  files: CanvasFile[];
  folders: CanvasFolder[];
  documents: CanvasDocument[];
  /** Optional so Canvas-only callers are unchanged. */
  external?: ExternalFile[];
  /** File ids a module or page names that Canvas would not hand over (no access, deleted). */
  unresolvedFileIds?: number[];
}

export interface PlannedItem {
  /** Stable id: `canvas:file/<id>`, `canvas:page/<slug>`, `canvas:assignment/<id>`, ... */
  source: string;
  courseId: number;
  /** Path segments below the chosen folder, ending in the file name. */
  path: string[];
  size: number;
  modifiedAt: string | null;
  /** Set for downloads; null for inline items. */
  url: string | null;
  /** Set for inline items; null for downloads. */
  content: string | null;
  /** Download needs this system's session cookie (and only that host). Absent means Canvas's signed URL, no cookies. */
  session?: "gradescope";
}

export type SkipReason = "locked" | "no-url" | "unavailable";

export interface SkippedFile {
  source: string;
  name: string;
  reason: SkipReason;
}

export interface CoursePlan {
  courseId: number;
  /** Folder name (archive) or slug (ingest); the unit the manifest is kept for. */
  folder: string;
  /** Directory of this course below the chosen folder. */
  dir: string[];
  items: PlannedItem[];
  skipped: SkippedFile[];
}

/** `course files/Lectures/Week 1` → `["Lectures", "Week 1"]` */
function folderSegments(fullName: string | undefined): string[] {
  if (!fullName) return [];
  const parts = fullName.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "course files") parts.shift();
  return parts.map((part) => sanitizeSegment(part, "folder"));
}

const utf8 = new TextEncoder();

/** Source id for a document. */
export function documentSource(doc: Pick<CanvasDocument, "kind" | "key">): string {
  return `canvas:${doc.kind}/${doc.key}`;
}

export function fileSource(id: number): string {
  return `canvas:file/${id}`;
}

/** Plan one course. `folder` must already be unique among the courses being planned. */
export function planCourse(
  course: Pick<Course, "id" | "name" | "courseCode">,
  sources: CourseSources,
  layout: Layout = archiveLayout,
  folder: string = layout.courseName(course),
): CoursePlan {
  const { modules, files, folders, documents } = sources;
  const dir = layout.courseDir(folder);
  const byId = new Map(files.map((file) => [file.id, file]));
  const folderById = new Map(folders.map((entry) => [entry.id, entry.fullName]));
  const placed = new Set<number>();
  const skipped: SkippedFile[] = [];
  const savedPath = new Map<number, string[]>();
  const entries: { dir: string[]; name: string; fileId?: number; doc?: CanvasDocument; build: (name: string) => PlannedItem }[] = [];

  const placeFile = (target: string[], file: CanvasFile, original = false) => {
    placed.add(file.id);
    const source = fileSource(file.id);
    if (file.locked) return void skipped.push({ source, name: file.displayName, reason: "locked" });
    if (!file.url) return void skipped.push({ source, name: file.displayName, reason: "no-url" });
    entries.push({
      dir: target,
      fileId: file.id,
      // Canvas's `filename` swaps spaces for "+"; an attachment keeps the name the instructor gave it.
      name: sanitizeFilename((original ? file.displayName : file.filename) || file.displayName, `file-${file.id}`),
      build: (name) => ({
        source,
        courseId: course.id,
        path: [...target, name],
        size: file.size,
        modifiedAt: file.updatedAt,
        url: file.url,
        content: null,
      }),
    });
  };

  const ordered = [...modules].sort((a, b) => a.position - b.position || a.id - b.id);
  for (const module of ordered) {
    const target = layout.moduleDir(dir, module);
    for (const fileId of module.fileIds) {
      const file = byId.get(fileId);
      if (file && !placed.has(file.id)) placeFile(target, file);
    }
  }

  // A file a page, assignment or announcement attaches goes beside that page (the first to name it),
  // unless a module already holds it.
  const docDir = (doc: CanvasDocument) => (doc.kind === "syllabus" ? layout.syllabusDir(dir) : layout.documentDir(dir, doc.kind));
  for (const doc of documents) {
    for (const id of doc.attachmentIds ?? []) {
      const file = byId.get(id);
      if (file && !placed.has(file.id)) placeFile(docDir(doc), file, true);
    }
  }
  for (const id of sources.unresolvedFileIds ?? []) {
    if (!placed.has(id)) skipped.push({ source: fileSource(id), name: `file ${id}`, reason: "unavailable" });
  }

  const loose = files.filter((file) => !placed.has(file.id)).sort((a, b) => a.id - b.id);
  for (const file of loose) {
    const isSyllabus = /syllabus/i.test(file.displayName);
    const sub = folderSegments(file.folderId === null ? undefined : folderById.get(file.folderId));
    placeFile(isSyllabus ? layout.syllabusDir(dir) : layout.looseDir(dir, sub), file);
  }

  for (const ext of sources.external ?? []) {
    const target = layout.externalDir(dir, ext.system);
    entries.push({
      dir: target,
      name: sanitizeFilename(ext.filename, "handout.pdf"),
      build: (name) => ({
        source: ext.source,
        courseId: course.id,
        path: [...target, name],
        size: 0,
        modifiedAt: null,
        url: ext.url,
        content: null,
        session: ext.system,
      }),
    });
  }

  for (const doc of documents) {
    const target = docDir(doc);
    entries.push({
      dir: target,
      name: layout.documentName(doc),
      doc,
      // Built after the files are named, so the links in the page point at where they landed.
      build: (name) => {
        const links = new Map<number, string>();
        for (const id of doc.attachmentIds ?? []) {
          const at = savedPath.get(id);
          if (at) links.set(id, relativeLink(target, at));
        }
        const content = renderDocument(doc, links);
        return {
          source: documentSource(doc),
          courseId: course.id,
          path: [...target, name],
          size: utf8.encode(content).length,
          modifiedAt: doc.modifiedAt,
          url: null,
          content,
        };
      },
    });
  }

  // Unique names per directory (case-insensitive), in plan order.
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.dir.join("/").toLowerCase();
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const named: { entry: (typeof entries)[number]; name: string }[] = [];
  for (const group of groups.values()) {
    const names = uniqueNames(group.map((entry) => entry.name));
    group.forEach((entry, i) => named.push({ entry, name: names[i] as string }));
  }
  // Files first, so each page can link to the path its attachments were given.
  const items: PlannedItem[] = [];
  for (const { entry, name } of named) {
    if (entry.doc) continue;
    const item = entry.build(name);
    items.push(item);
    if (entry.fileId !== undefined) savedPath.set(entry.fileId, item.path);
  }
  for (const { entry, name } of named) if (entry.doc) items.push(entry.build(name));

  items.sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"), undefined, { numeric: true }));
  return { courseId: course.id, folder, dir, items, skipped };
}

/** Course folder names already handed out, by Canvas course id. Persisted between runs (`dirs.ts`). */
export type DirBindings = Record<number, string>;

/**
 * A course keeps the folder it was first given, whatever else is selected
 * later: names are tied to the immutable Canvas course id, never to this
 * run's selection. A course with no binding takes its natural name, or the
 * next ` (2)` / `-2` that no other course (selected or not) holds. Case-insensitive.
 */
export function allocateCourseNames(
  courses: Pick<Course, "id" | "name" | "courseCode">[],
  layout: Layout,
  bound: DirBindings = {},
): string[] {
  const taken = new Set(Object.values(bound).map((name) => name.toLowerCase()));
  return courses.map((course) => {
    const existing = bound[course.id];
    if (existing !== undefined) return existing;
    const base = layout.courseName(course);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = layout.numberedCourseName(base, n);
    taken.add(name.toLowerCase());
    return name;
  });
}

/**
 * Plan several courses. Two courses that would share a folder name (a re-run
 * section, a code reused across terms) get ` (2)` rather than merging, and
 * `bound` keeps each course in the folder it already has.
 */
export function planCourses(
  inputs: { course: Pick<Course, "id" | "name" | "courseCode">; sources: CourseSources }[],
  layout: Layout = archiveLayout,
  bound: DirBindings = {},
): CoursePlan[] {
  const names = allocateCourseNames(inputs.map(({ course }) => course), layout, bound);
  return inputs.map(({ course, sources }, i) => planCourse(course, sources, layout, names[i] as string));
}

/** The bindings a set of plans used, to be remembered before they write anything. */
export const bindingsOf = (plans: CoursePlan[]): DirBindings =>
  Object.fromEntries(plans.map((plan) => [plan.courseId, plan.folder]));

export interface PlanSummary {
  courses: number;
  items: number;
  bytes: number;
  skipped: number;
}

export function summarize(plans: CoursePlan[]): PlanSummary {
  return {
    courses: plans.length,
    items: plans.reduce((n, plan) => n + plan.items.length, 0),
    bytes: plans.reduce((n, plan) => n + plan.items.reduce((m, item) => m + item.size, 0), 0),
    skipped: plans.reduce((n, plan) => n + plan.skipped.length, 0),
  };
}
