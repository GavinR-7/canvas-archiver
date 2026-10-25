/**
 * The course browser's logic: a course's plan as a folder tree, the ticked
 * items, and which of them are already saved.
 *
 * Pure apart from the selection storage. The tree is built from the same plan
 * the full archive uses, so a ticked item lands exactly where the archive would
 * put it and the manifest skips it when it is unchanged.
 */

import { decide, type CourseManifest } from "./manifest";
import type { CoursePlan, PlannedItem } from "./plan";

export interface FolderNode {
  kind: "folder";
  name: string;
  /** Path below the course folder, e.g. `["02 Lectures"]`. */
  path: string[];
  folders: FolderNode[];
  files: FileNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  item: PlannedItem;
}

/** The plan's items as folders and files below the course folder, folders and files in name order. */
export function buildTree(plan: CoursePlan): FolderNode {
  const root: FolderNode = { kind: "folder", name: plan.dir[plan.dir.length - 1] ?? "", path: [], folders: [], files: [] };
  for (const item of plan.items) {
    const parts = item.path.slice(plan.dir.length);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.find((f) => f.name === part);
      if (!next) {
        next = { kind: "folder", name: part, path: [...at.path, part], folders: [], files: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.files.push({ kind: "file", name: parts[parts.length - 1] ?? item.path[item.path.length - 1] ?? "", item });
  }
  const order = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const sort = (node: FolderNode) => {
    node.folders.sort(order);
    node.files.sort(order);
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every item under a folder, however deep. */
export function itemsUnder(node: FolderNode): PlannedItem[] {
  return [...node.files.map((f) => f.item), ...node.folders.flatMap(itemsUnder)];
}

export type Tick = "none" | "some" | "all";

export function tickOf(node: FolderNode, selected: ReadonlySet<string>): Tick {
  const items = itemsUnder(node);
  const on = items.filter((i) => selected.has(i.source)).length;
  return on === 0 ? "none" : on === items.length ? "all" : "some";
}

/** Tick or untick a whole folder. A new set; the old one is not changed. */
export function setFolder(selected: ReadonlySet<string>, node: FolderNode, on: boolean): Set<string> {
  const next = new Set(selected);
  for (const item of itemsUnder(node)) {
    if (on) next.add(item.source);
    else next.delete(item.source);
  }
  return next;
}

/** The plan reduced to the ticked items, for `runArchive`. Same folder, same manifest. */
export function subsetPlan(plan: CoursePlan, selected: ReadonlySet<string>): CoursePlan {
  return { ...plan, items: plan.items.filter((item) => selected.has(item.source)) };
}

/** Saved at the planned path. A Gradescope handout has no size or time to compare, so a record at its path counts (the run still asks the host before skipping it). */
const isSaved = (item: PlannedItem, manifest: CourseManifest) => {
  const verdict = decide(item, manifest.entries[item.source]);
  return verdict === "unchanged" || verdict === "revalidate";
};

/** Sources the manifest says are already saved and unchanged, so the list can say so. */
export function savedSources(plan: CoursePlan, manifest: CourseManifest): Set<string> {
  return new Set(
    plan.items
      .filter((item) => manifest.entries[item.source]?.method !== "downloads" && isSaved(item, manifest))
      .map((i) => i.source),
  );
}

/** Sources whose only copy is in the browser's Downloads folder, not in the archive folder. */
export function downloadsSources(plan: CoursePlan, manifest: CourseManifest): Set<string> {
  return new Set(
    plan.items
      .filter((item) => manifest.entries[item.source]?.method === "downloads" && isSaved(item, manifest))
      .map((i) => i.source),
  );
}

// --- Selection, remembered per course ----------------------------------------

const key = (courseId: number) => `browse.selected.${courseId}`;

/** Ticks that no longer match anything in the course (a deleted file) are dropped. */
export function pruneSelection(selected: Iterable<string>, plan: CoursePlan): Set<string> {
  const known = new Set(plan.items.map((i) => i.source));
  return new Set([...selected].filter((source) => known.has(source)));
}

export async function loadSelection(courseId: number): Promise<Set<string>> {
  try {
    const stored = (await chrome.storage.local.get(key(courseId)))[key(courseId)];
    return new Set(Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

export async function saveSelection(courseId: number, selected: ReadonlySet<string>): Promise<void> {
  try {
    await chrome.storage.local.set({ [key(courseId)]: [...selected] });
  } catch {
    // Not remembered; the ticks still apply for this page.
  }
}
