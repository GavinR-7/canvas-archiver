/**
 * Read-only Canvas calls for files and modules, plus their normalisers.
 * Normalisers are exported and tested; the fetchers are not (network).
 */

import { getAll } from "@/src/canvas/client";
import { AccessDeniedError, NotFoundError } from "@/src/canvas/errors";
import type { CanvasFile, CanvasFolder, CanvasModule } from "./plan";

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
