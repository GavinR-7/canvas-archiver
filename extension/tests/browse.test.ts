import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTree, itemsUnder, loadSelection, pruneSelection, savedSources, saveSelection, setFolder, subsetPlan, tickOf } from "@/src/files/browse";
import { archiveLayout } from "@/src/files/layout";
import { emptyManifest, hashText, type CourseManifest } from "@/src/files/manifest";
import { planCourse, type CanvasDocument, type CanvasFile, type CourseSources } from "@/src/files/plan";
import { runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";

const course = { id: 7, name: "Embedded Systems", courseCode: "ECE 3140" };
const file = (id: number, name: string, extra: Partial<CanvasFile> = {}): CanvasFile => ({
  id, displayName: name, filename: name, size: 100, updatedAt: "t1", url: `https://canvas.example/files/${id}/download?verifier=x`, folderId: null, locked: false, ...extra,
});
const doc = (key: string, title: string): CanvasDocument => ({ kind: "page", key, title, html: `<p>${title}</p>`, modifiedAt: "t1", htmlUrl: null });
const sources: CourseSources = {
  modules: [
    { id: 1, name: "Week 1", position: 1, fileIds: [1, 2] },
    { id: 2, name: "Week 2", position: 2, fileIds: [3] },
  ],
  files: [file(1, "lec1.pdf"), file(2, "lab1.pdf"), file(3, "lec2.pdf"), file(4, "notes.txt", { folderId: 9 }), file(5, "locked.pdf", { locked: true })],
  folders: [{ id: 9, fullName: "course files/Extras" }],
  documents: [doc("intro", "Intro")],
};
const plan = planCourse(course, sources);

describe("buildTree", () => {
  it("makes folders and files below the course folder, in order, with sizes and dates", () => {
    const tree = buildTree(plan);
    expect(tree.folders.map((f) => f.name)).toEqual(["01 Week 1", "02 Week 2", "Course files", "Pages"]);
    expect(tree.folders[0]?.files.map((f) => f.name)).toEqual(["lab1.pdf", "lec1.pdf"]);
    expect(tree.folders[0]?.files[0]?.item).toMatchObject({ source: "canvas:file/2", size: 100, modifiedAt: "t1" });
    expect(itemsUnder(tree)).toHaveLength(plan.items.length);
  });
  it("leaves locked files out and nests deeper folders", () => {
    expect(itemsUnder(buildTree(plan)).some((i) => i.source === "canvas:file/5")).toBe(false);
    const deep = planCourse(course, { ...sources, files: [file(4, "x.txt", { folderId: 9 })], folders: [{ id: 9, fullName: "course files/A/B" }], modules: [], documents: [] });
    const loose = buildTree(deep).folders[0];
    expect(loose?.name).toBe("Course files");
    expect(loose?.folders[0]?.name).toBe("A");
    expect(loose?.folders[0]?.folders[0]?.files[0]?.name).toBe("x.txt");
    expect(loose?.folders[0]?.folders[0]?.path).toEqual(["Course files", "A", "B"]);
  });
});

describe("ticking", () => {
  const tree = buildTree(plan);
  const week1 = tree.folders[0] as (typeof tree)["folders"][number];
  it("ticks and unticks a folder as a whole and reports none / some / all", () => {
    let selected = new Set<string>();
    expect(tickOf(week1, selected)).toBe("none");
    selected = setFolder(selected, week1, true);
    expect([...selected].sort()).toEqual(["canvas:file/1", "canvas:file/2"]);
    expect(tickOf(week1, selected)).toBe("all");
    selected.delete("canvas:file/1");
    expect(tickOf(week1, selected)).toBe("some");
    expect(setFolder(selected, week1, false).size).toBe(0);
  });
  it("reduces the plan to the ticked items and keeps its folder", () => {
    const sub = subsetPlan(plan, new Set(["canvas:file/3"]));
    expect(sub.items.map((i) => i.source)).toEqual(["canvas:file/3"]);
    expect(sub.dir).toEqual(plan.dir);
  });
});

describe("selection persistence", () => {
  const stub = (data: Record<string, unknown> = {}) =>
    vi.stubGlobal("chrome", { storage: { local: { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set: async (o: Record<string, unknown>) => void Object.assign(data, o) } } });
  afterEach(() => vi.unstubAllGlobals());

  it("is remembered per course and survives a reload", async () => {
    stub();
    await saveSelection(7, new Set(["canvas:file/1", "canvas:file/3"]));
    await saveSelection(8, new Set(["canvas:file/9"]));
    expect([...(await loadSelection(7))].sort()).toEqual(["canvas:file/1", "canvas:file/3"]);
    expect([...(await loadSelection(8))]).toEqual(["canvas:file/9"]);
    expect((await loadSelection(99)).size).toBe(0);
  });
  it("ignores junk in storage, and prune drops ticks for files that are gone", async () => {
    stub({ "browse.selected.7": ["canvas:file/1", 5, null, "canvas:file/404"] });
    const loaded = await loadSelection(7);
    expect([...loaded].sort()).toEqual(["canvas:file/1", "canvas:file/404"]);
    expect([...pruneSelection(loaded, plan)]).toEqual(["canvas:file/1"]);
  });
});

function memory() {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const sink: FileSink = {
    keepsRecords: true,
    size: async (p) => (disk.has(p.join("/")) ? (disk.get(p.join("/")) as string).length : null),
    readText: async (p) => disk.get(p.join("/")) ?? null,
    writeText: async (p, t) => void disk.set(p.join("/"), t),
    save: async (item) => {
      calls.push(item.source);
      const text = item.content ?? `bytes of ${item.source}`;
      disk.set(item.path.join("/"), text);
      return { size: text.length, sha256: hashText(text) };
    },
  };
  const data = new Map<number, CourseManifest>();
  const store: ManifestStore = {
    load: async (p) => data.get(p.courseId) ?? emptyManifest(p.courseId),
    save: async (p, m) => void data.set(p.courseId, structuredClone(m)),
  };
  return { sink, store, calls, data };
}

describe("downloading ticked items through the incremental engine", () => {
  it("saves only what is ticked, then skips it unchanged, and marks it saved", async () => {
    const { sink, store, calls, data } = memory();
    const ticked = new Set(["canvas:file/1", "canvas:file/3"]);
    const first = await runArchive([subsetPlan(plan, ticked)], archiveLayout, sink, store);
    expect(first).toMatchObject({ saved: 2, unchanged: 0, failed: 0 });
    expect(calls.sort()).toEqual(["canvas:file/1", "canvas:file/3"]);

    calls.length = 0;
    const second = await runArchive([subsetPlan(plan, ticked)], archiveLayout, sink, store);
    expect(second).toMatchObject({ saved: 0, unchanged: 2 });
    expect(calls).toEqual([]);

    expect([...savedSources(plan, data.get(7) as CourseManifest)].sort()).toEqual(["canvas:file/1", "canvas:file/3"]);
  });
  it("downloads a ticked file again when it changed, and only that one", async () => {
    const { sink, store, calls } = memory();
    const ticked = new Set(["canvas:file/1", "canvas:file/3"]);
    await runArchive([subsetPlan(plan, ticked)], archiveLayout, sink, store);
    calls.length = 0;
    const changed = planCourse(course, { ...sources, files: sources.files.map((f) => (f.id === 3 ? { ...f, updatedAt: "t2" } : f)) });
    const result = await runArchive([subsetPlan(changed, ticked)], archiveLayout, sink, store);
    expect(result).toMatchObject({ saved: 1, unchanged: 1 });
    expect(calls).toEqual(["canvas:file/3"]);
  });
  it("ticking more later fetches only the additions", async () => {
    const { sink, store, calls } = memory();
    await runArchive([subsetPlan(plan, new Set(["canvas:file/1"]))], archiveLayout, sink, store);
    calls.length = 0;
    await runArchive([subsetPlan(plan, new Set(["canvas:file/1", "canvas:file/2"]))], archiveLayout, sink, store);
    expect(calls).toEqual(["canvas:file/2"]);
  });
});
