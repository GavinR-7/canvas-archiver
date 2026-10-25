/**
 * Read-only Canvas calls for files and modules, plus their normalisers.
 * Normalisers are exported and tested; the fetchers are not (network).
 */

import { getAll, getOne } from "@/src/canvas/client";
import { AccessDeniedError, NotFoundError } from "@/src/canvas/errors";
import type { CanvasDocument, CanvasFile, CanvasFolder, CanvasModule, CourseSources } from "./plan";

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function normalizeFile(raw: Raw): CanvasFile | null {
  const id = num(raw["id"]);
  if (id === null) return null;
  const displayName = str(raw["display_name"]) ?? str(raw["filename"]) ?? `file-${id}`;
  return {
    id,
    displayName,
    filename: str(raw["filename"]) ?? displayName,
    size: num(raw["size"]) ?? 0,
    updatedAt: str(raw["updated_at"]) ?? str(raw["modified_at"]),
    url: str(raw["url"]),
    folderId: num(raw["folder_id"]),
    // Canvas marks files hidden from students or past their unlock date with `locked_for_user`.
    locked: raw["locked_for_user"] === true || raw["locked"] === true,
  };
}

export function normalizeFolder(raw: Raw): CanvasFolder | null {
  const id = num(raw["id"]);
  const fullName = str(raw["full_name"]);
  return id === null || fullName === null ? null : { id, fullName };
}

export function normalizeModule(raw: Raw, index: number): CanvasModule | null {
  const id = num(raw["id"]);
  if (id === null) return null;
  const items = Array.isArray(raw["items"]) ? (raw["items"] as Raw[]) : [];
  const fileIds = items
    .filter((item) => item["type"] === "File")
    .map((item) => num(item["content_id"]))
    .filter((n): n is number => n !== null);
  return {
    id,
    name: str(raw["name"]) ?? `Module ${index + 1}`,
    position: num(raw["position"]) ?? index + 1,
    fileIds,
  };
}

/** A course whose Files tab or Modules are disabled is empty, not an error. */
async function tolerant<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AccessDeniedError || error instanceof NotFoundError) return [];
    throw error;
  }
}

export async function fetchCourseFiles(courseId: number): Promise<CanvasFile[]> {
  const raw = await tolerant(() => getAll<Raw>(`/courses/${courseId}/files`));
  return raw.map(normalizeFile).filter((f): f is CanvasFile => f !== null);
}

export async function fetchCourseFolders(courseId: number): Promise<CanvasFolder[]> {
  const raw = await tolerant(() => getAll<Raw>(`/courses/${courseId}/folders`));
  return raw.map(normalizeFolder).filter((f): f is CanvasFolder => f !== null);
}

export async function fetchCourseModules(courseId: number): Promise<CanvasModule[]> {
  const raw = await tolerant(() => getAll<Raw>(`/courses/${courseId}/modules`, { "include[]": ["items"] }));
  const modules: CanvasModule[] = [];
  for (const [i, module] of raw.entries()) {
    // Canvas omits `items` for modules with more than 100 of them; ask per module.
    if (!Array.isArray(module["items"])) {
      const id = num(module["id"]);
      if (id !== null) {
        module["items"] = await tolerant(() => getAll<Raw>(`/courses/${courseId}/modules/${id}/items`));
      }
    }
    const normalized = normalizeModule(module, i);
    if (normalized) modules.push(normalized);
  }
  return modules;
}

// --- Documents: pages, assignments, announcements, syllabus ---------------

export function normalizeAssignment(raw: Raw): CanvasDocument | null {
  const id = num(raw["id"]);
  if (id === null) return null;
  return {
    kind: "assignment",
    key: String(id),
    title: str(raw["name"]) ?? `Assignment ${id}`,
    html: str(raw["description"]) ?? "",
    modifiedAt: str(raw["updated_at"]),
    htmlUrl: str(raw["html_url"]),
  };
}

export function normalizeAnnouncement(raw: Raw): CanvasDocument | null {
  const id = num(raw["id"]);
  if (id === null) return null;
  return {
    kind: "announcement",
    key: String(id),
    title: str(raw["title"]) ?? `Announcement ${id}`,
    html: str(raw["message"]) ?? "",
    modifiedAt: str(raw["posted_at"]) ?? str(raw["created_at"]),
    htmlUrl: str(raw["html_url"]),
  };
}

export function normalizePage(raw: Raw): CanvasDocument | null {
  const slug = str(raw["url"]);
  if (slug === null) return null;
  return {
    kind: "page",
    key: slug,
    title: str(raw["title"]) ?? slug,
    html: str(raw["body"]) ?? "",
    modifiedAt: str(raw["updated_at"]),
    htmlUrl: str(raw["html_url"]),
  };
}

export function normalizeSyllabus(courseId: number, raw: Raw): CanvasDocument | null {
  const body = str(raw["syllabus_body"]);
  if (body === null) return null;
  return { kind: "syllabus", key: String(courseId), title: "Syllabus", html: body, modifiedAt: null, htmlUrl: null };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function fetchCoursePages(courseId: number): Promise<CanvasDocument[]> {
  const list = await tolerant(() => getAll<Raw>(`/courses/${courseId}/pages`));
  const slugs = list.map((p) => str(p["url"])).filter((s): s is string => s !== null);
  const bodies = await mapLimit(slugs, 4, async (slug) => {
    try {
      return normalizePage(await getOne<Raw>(`/courses/${courseId}/pages/${encodeURIComponent(slug)}`));
    } catch (error) {
      if (error instanceof AccessDeniedError || error instanceof NotFoundError) return null;
      throw error;
    }
  });
  return bodies.filter((d): d is CanvasDocument => d !== null);
}

export async function fetchCourseAssignments(courseId: number): Promise<CanvasDocument[]> {
  const raw = await tolerant(() => getAll<Raw>(`/courses/${courseId}/assignments`));
  return raw.map(normalizeAssignment).filter((d): d is CanvasDocument => d !== null);
}

export async function fetchCourseAnnouncements(courseId: number): Promise<CanvasDocument[]> {
  const end = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const raw = await tolerant(() =>
    getAll<Raw>("/announcements", {
      "context_codes[]": [`course_${courseId}`],
      start_date: "2000-01-01",
      end_date: end,
    }),
  );
  return raw.map(normalizeAnnouncement).filter((d): d is CanvasDocument => d !== null);
}

export async function fetchCourseSyllabus(courseId: number): Promise<CanvasDocument[]> {
  try {
    const course = await getOne<Raw>(`/courses/${courseId}`, { "include[]": ["syllabus_body"] });
    const doc = normalizeSyllabus(courseId, course);
    return doc ? [doc] : [];
  } catch (error) {
    if (error instanceof AccessDeniedError || error instanceof NotFoundError) return [];
    throw error;
  }
}

/** Everything the planner needs for one course. Each source degrades to empty on its own. */
export async function fetchCourseSources(courseId: number): Promise<CourseSources> {
  const [modules, files, folders, pages, assignments, announcements, syllabus] = await Promise.all([
    fetchCourseModules(courseId),
    fetchCourseFiles(courseId),
    fetchCourseFolders(courseId),
    fetchCoursePages(courseId),
    fetchCourseAssignments(courseId),
    fetchCourseAnnouncements(courseId),
    fetchCourseSyllabus(courseId),
  ]);
  return { modules, files, folders, documents: [...syllabus, ...pages, ...assignments, ...announcements] };
}
