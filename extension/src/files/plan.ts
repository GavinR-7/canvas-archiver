/**
 * The download plan: which Canvas files go to which relative path.
 *
 * Pure. No network and no file system, so the whole layout is unit-tested.
 * Layout, under the folder the user chose:
 *
 *   Cornell/<course>/<NN module name>/<file>      files linked from a module
 *   Cornell/<course>/Course files/<folders>/<file> files not in any module
 *
 * Module folders are prefixed with their position (`01 Week 1`) so they sort in
 * the order the instructor arranged them, not alphabetically ("Week 10" before
 * "Week 2"). A file linked from several modules is placed once, in the first.
 */

import type { Course } from "@/src/types/canvas";
import { sanitizeFilename, sanitizeSegment, uniqueNames } from "./paths";

export const ROOT_FOLDER = "Cornell";
export const LOOSE_FOLDER = "Course files";

export interface CanvasFile {
  id: number;
  displayName: string;
  filename: string;
  /** Bytes, as Canvas reports them. Used to skip files already on disk. */
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

export interface PlannedFile {
  fileId: number;
  courseId: number;
  /** Path segments below the chosen folder, ending in the file name. */
  path: string[];
  size: number;
  updatedAt: string | null;
  url: string;
}

export type SkipReason = "locked" | "no-url";

export interface SkippedFile {
  fileId: number;
  name: string;
  reason: SkipReason;
}

export interface CoursePlan {
  courseId: number;
  folder: string;
  files: PlannedFile[];
  skipped: SkippedFile[];
}

export function courseFolderName(course: Pick<Course, "name" | "courseCode">): string {
  const { courseCode, name } = course;
  const label = courseCode && name && name !== courseCode ? `${courseCode} ${name}` : name || courseCode;
  return sanitizeSegment(label, "Course");
}

/** `course files/Lectures/Week 1` → `["Lectures", "Week 1"]` */
function folderSegments(fullName: string | undefined): string[] {
  if (!fullName) return [];
  const parts = fullName.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "course files") parts.shift();
  return parts.map((part) => sanitizeSegment(part, "folder"));
}

export function moduleFolderName(module: Pick<CanvasModule, "name" | "position">): string {
  const prefix = String(module.position).padStart(2, "0");
  return sanitizeSegment(`${prefix} ${module.name}`, `${prefix} Module`);
}

/** Plan one course. `folderNames` should already be unique across the courses being planned. */
export function planCourse(
  course: Pick<Course, "id" | "name" | "courseCode">,
  modules: CanvasModule[],
  files: CanvasFile[],
  folders: CanvasFolder[],
  folderName: string = courseFolderName(course),
): CoursePlan {
  const byId = new Map(files.map((file) => [file.id, file]));
  const folderById = new Map(folders.map((folder) => [folder.id, folder.fullName]));
  const placed = new Set<number>();
  const skipped: SkippedFile[] = [];
  const entries: { dir: string[]; file: CanvasFile }[] = [];

  const place = (dir: string[], file: CanvasFile) => {
    placed.add(file.id);
    if (file.locked) return void skipped.push({ fileId: file.id, name: file.displayName, reason: "locked" });
    if (!file.url) return void skipped.push({ fileId: file.id, name: file.displayName, reason: "no-url" });
    entries.push({ dir, file });
  };

  const ordered = [...modules].sort((a, b) => a.position - b.position || a.id - b.id);
  for (const module of ordered) {
    const dir = [ROOT_FOLDER, folderName, moduleFolderName(module)];
    for (const fileId of module.fileIds) {
      const file = byId.get(fileId);
      if (file && !placed.has(file.id)) place(dir, file);
    }
  }

  const loose = files.filter((file) => !placed.has(file.id)).sort((a, b) => a.id - b.id);
  for (const file of loose) {
    const sub = folderSegments(file.folderId === null ? undefined : folderById.get(file.folderId));
    place([ROOT_FOLDER, folderName, LOOSE_FOLDER, ...sub], file);
  }

  // Unique file names per directory, in plan order.
  const dirs = new Map<string, { dir: string[]; file: CanvasFile }[]>();
  for (const entry of entries) {
    const key = entry.dir.join("/").toLowerCase();
    const group = dirs.get(key);
    if (group) group.push(entry);
    else dirs.set(key, [entry]);
  }

  const planned: PlannedFile[] = [];
  for (const group of dirs.values()) {
    const names = uniqueNames(
      group.map(({ file }) => sanitizeFilename(file.filename || file.displayName, `file-${file.id}`)),
    );
    group.forEach(({ dir, file }, i) => {
      planned.push({
        fileId: file.id,
        courseId: course.id,
        path: [...dir, names[i] as string],
        size: file.size,
        updatedAt: file.updatedAt,
        url: file.url as string,
      });
    });
  }

  planned.sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"), undefined, { numeric: true }));
  return { courseId: course.id, folder: folderName, files: planned, skipped };
}

/**
 * Plan several courses. Two courses that would share a folder name (a re-run
 * section, a code reused across terms) get ` (2)` rather than merging.
 */
export function planCourses(
  inputs: {
    course: Pick<Course, "id" | "name" | "courseCode">;
    modules: CanvasModule[];
    files: CanvasFile[];
    folders: CanvasFolder[];
  }[],
): CoursePlan[] {
  const names = uniqueNames(inputs.map(({ course }) => courseFolderName(course)));
  return inputs.map(({ course, modules, files, folders }, i) =>
    planCourse(course, modules, files, folders, names[i]),
  );
}

export interface PlanSummary {
  courses: number;
  files: number;
  bytes: number;
  skipped: number;
}

export function summarize(plans: CoursePlan[]): PlanSummary {
  return {
    courses: plans.length,
    files: plans.reduce((n, plan) => n + plan.files.length, 0),
    bytes: plans.reduce((n, plan) => n + plan.files.reduce((m, f) => m + f.size, 0), 0),
    skipped: plans.reduce((n, plan) => n + plan.skipped.length, 0),
  };
}
