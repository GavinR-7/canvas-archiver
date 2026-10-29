import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeAnnouncement, normalizeAssignment, normalizeFile, normalizeModule, normalizePage, normalizeSyllabus } from "@/src/files/api";
import { archiveLayout, ingestCourseSlug, ingestLayout, type Layout } from "@/src/files/layout";
import { batchFileName, buildBatch, decide, emptyManifest, hashText, parseManifest, type CourseManifest, type ManifestEntry } from "@/src/files/manifest";
import { sanitizeFilename, sanitizeSegment, slugify, uniqueNames } from "@/src/files/paths";
import {
  courseFolderName,
  planCourse,
  planCourses,
  summarize,
  type CanvasDocument,
  type CanvasFile,
  type CourseSources,
  type PlannedItem,
} from "@/src/files/plan";
import { renderDocument } from "@/src/files/render";
import { looksBlockedByCors, runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";
import { Sha256, sha256Hex } from "@/src/files/sha256";
const file = (id: number, name: string, extra: Partial<CanvasFile> = {}): CanvasFile => ({
  id,
  displayName: name,
  filename: name,
  size: 100,
  updatedAt: null,
  url: `https://canvas.cornell.edu/files/${id}/download?verifier=x`,
  folderId: null,
  locked: false,
  ...extra,
});

const course = { id: 7, name: "Embedded Systems", courseCode: "ECE 3140" };

describe("sanitizeSegment", () => {
  it("replaces characters Windows rejects", () => {
    expect(sanitizeSegment('Week 3: Interrupts / Timers?')).toBe("Week 3- Interrupts - Timers-");
  });
  it("strips trailing dots and spaces, and leading dots", () => {
    expect(sanitizeSegment("notes. . ")).toBe("notes");
    expect(sanitizeSegment("..hidden")).toBe("hidden");
  });
  it("never returns '..', '.' or empty", () => {
    expect(sanitizeSegment("..")).toBe("untitled");
    expect(sanitizeSegment("   ")).toBe("untitled");
    expect(sanitizeSegment("/")).toBe("-");
  });
  it("prefixes Windows device names", () => {
    expect(sanitizeSegment("CON")).toBe("_CON");
    expect(sanitizeSegment("nul.txt")).toBe("_nul.txt");
    expect(sanitizeSegment("console")).toBe("console");
  });
  it("truncates long names", () => {
    expect(sanitizeSegment("a".repeat(300)).length).toBe(100);
  });
});

describe("sanitizeFilename", () => {
  it("keeps the extension when truncating", () => {
    const name = sanitizeFilename(`${"x".repeat(300)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(".pdf")).toBe(true);
  });
  it("cleans illegal characters", () => {
    expect(sanitizeFilename("Lab 2: final?.pdf")).toBe("Lab 2- final-.pdf");
  });
});

describe("uniqueNames", () => {
  it("numbers case-insensitive duplicates, first keeps its name", () => {
    expect(uniqueNames(["a.pdf", "A.pdf", "a.pdf", "b.pdf"])).toEqual(["a.pdf", "A (2).pdf", "a (3).pdf", "b.pdf"]);
  });
  it("does not collide with an existing numbered name", () => {
    expect(uniqueNames(["a (2).pdf", "a.pdf", "a.pdf"])).toEqual(["a (2).pdf", "a.pdf", "a (3).pdf"]);
  });
});

const none: CourseSources = { modules: [], files: [], folders: [], documents: [] };
const src = (over: Partial<CourseSources> = {}): CourseSources => ({ ...none, ...over });
const doc = (kind: CanvasDocument["kind"], key: string, title: string, over: Partial<CanvasDocument> = {}): CanvasDocument => ({
  kind, key, title, html: `<p>${title}</p>`, modifiedAt: "2026-10-01T00:00:00Z", htmlUrl: null, ...over,
});
const paths = (plan: { items: PlannedItem[] }) => plan.items.map((i) => i.path.join("/"));

describe("planCourse (archive layout)", () => {
  it("lays files out as Cornell/<course>/<NN module>/<file>", () => {
    const plan = planCourse(course, src({ modules: [{ id: 1, name: "Week 1: Intro", position: 1, fileIds: [10] }], files: [file(10, "lec1.pdf")] }));
    expect(paths(plan)).toEqual(["Cornell/ECE 3140 Embedded Systems/01 Week 1- Intro/lec1.pdf"]);
    expect(plan.items[0]).toMatchObject({ source: "canvas:file/10", content: null });
  });

  it("orders modules by position and prefixes so 10 sorts after 2", () => {
    const plan = planCourse(course, src({
      modules: [
        { id: 2, name: "Week 10", position: 10, fileIds: [2] },
        { id: 1, name: "Week 2", position: 2, fileIds: [1] },
      ],
      files: [file(1, "a.pdf"), file(2, "b.pdf")],
    }));
    expect(plan.items.map((i) => i.path[2])).toEqual(["02 Week 2", "10 Week 10"]);
  });

  it("places a file linked from two modules once, in the first", () => {
    const plan = planCourse(course, src({
      modules: [
        { id: 1, name: "A", position: 1, fileIds: [5] },
        { id: 2, name: "B", position: 2, fileIds: [5] },
      ],
      files: [file(5, "shared.pdf")],
    }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.path[2]).toBe("01 A");
  });

  it("puts files outside any module under Course files; syllabus files under Syllabus", () => {
    const plan = planCourse(course, src({
      files: [file(1, "syllabus.pdf", { folderId: 1 }), file(2, "w1.pdf", { folderId: 2 })],
      folders: [{ id: 1, fullName: "course files" }, { id: 2, fullName: "course files/Lectures/Week 1" }],
    }));
    expect(plan.items.map((i) => i.path.slice(2).join("/"))).toEqual(["Course files/Lectures/Week 1/w1.pdf", "Syllabus/syllabus.pdf"]);
  });

  it("skips locked files and files with no URL, and says why", () => {
    const plan = planCourse(course, src({ files: [file(1, "a.pdf", { locked: true }), file(2, "b.pdf", { url: null }), file(3, "c.pdf")] }));
    expect(plan.items.map((i) => i.source)).toEqual(["canvas:file/3"]);
    expect(plan.skipped).toEqual([
      { source: "canvas:file/1", name: "a.pdf", reason: "locked" },
      { source: "canvas:file/2", name: "b.pdf", reason: "no-url" },
    ]);
  });

  it("renames same-named files in one folder", () => {
    const plan = planCourse(course, src({ modules: [{ id: 1, name: "M", position: 1, fileIds: [1, 2] }], files: [file(1, "notes.pdf"), file(2, "Notes.pdf")] }));
    expect(plan.items.map((i) => i.path[3]).sort()).toEqual(["Notes (2).pdf", "notes.pdf"]);
  });

  it("ignores module file ids Canvas did not return", () => {
    expect(planCourse(course, src({ modules: [{ id: 1, name: "M", position: 1, fileIds: [99] }] })).items).toEqual([]);
  });

  it("never emits '..' or empty segments, whatever Canvas calls things", () => {
    const plan = planCourse(
      { id: 1, name: "..", courseCode: "" },
      src({ modules: [{ id: 1, name: "../../etc", position: 1, fileIds: [1] }], files: [file(1, "..")], documents: [doc("page", "x", "../..")] }),
    );
    for (const segment of plan.items.flatMap((i) => i.path)) {
      expect(segment).not.toBe("..");
      expect(segment).not.toBe("");
      expect(segment).not.toContain("/");
    }
  });

  it("renders pages, assignments, announcements and the syllabus as inline HTML items", () => {
    const plan = planCourse(course, src({
      documents: [
        doc("page", "week-1-notes", "Week 1 Notes"),
        doc("assignment", "55", "Lab 1"),
        doc("announcement", "9", "Exam moved"),
        doc("syllabus", "7", "Syllabus"),
      ],
    }));
    expect(plan.items.map((i) => [i.source, i.path.slice(2).join("/")])).toEqual([
      ["canvas:announcement/9", "Announcements/Exam moved.html"],
      ["canvas:assignment/55", "Assignments/Lab 1.html"],
      ["canvas:page/week-1-notes", "Pages/Week 1 Notes.html"],
      ["canvas:syllabus/7", "Syllabus/Syllabus.html"],
    ]);
    expect(plan.items.every((i) => i.url === null && i.content?.includes("<h1>"))).toBe(true);
    expect(plan.items[0]?.size).toBe(new TextEncoder().encode(plan.items[0]?.content as string).length);
  });
});

describe("planCourse (ingest layout)", () => {
  it("follows the knowledge ingest contract", () => {
    const plan = planCourse(
      course,
      src({
        modules: [{ id: 1, name: "05 EM Waves & Optics", position: 5, fileIds: [10] }],
        files: [file(10, "lec05.pdf"), file(11, "loose.pdf"), file(12, "Syllabus Fall.pdf")],
        documents: [doc("page", "p", "A Page"), doc("syllabus", "7", "Syllabus")],
      }),
      ingestLayout,
    );
    expect(plan.folder).toBe("ece3140");
    expect(paths(plan)).toEqual([
      "ece3140/05-05-em-waves-optics/lec05.pdf",
      "ece3140/_syllabus/Syllabus Fall.pdf",
      "ece3140/_syllabus/syllabus-syllabus.html",
      "ece3140/files/loose.pdf",
      "ece3140/files/page-a-page.html",
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  });
});

describe("planCourses", () => {
  it("keeps two courses with the same name apart", () => {
    const plans = planCourses([{ course, sources: none }, { course: { ...course, id: 8 }, sources: none }]);
    expect(plans.map((p) => p.folder)).toEqual(["ECE 3140 Embedded Systems", "ECE 3140 Embedded Systems (2)"]);
  });
  it("gives ingest slugs a -2 suffix on collision", () => {
    const plans = planCourses([{ course, sources: none }, { course: { ...course, id: 8 }, sources: none }], ingestLayout);
    expect(plans.map((p) => p.folder)).toEqual(["ece3140", "ece3140-2"]);
  });
  it("summarises counts and bytes", () => {
    const plan = planCourse(course, src({ files: [file(1, "a.pdf", { size: 5 }), file(2, "b.pdf", { locked: true })] }));
    expect(summarize([plan])).toEqual({ courses: 1, items: 1, bytes: 5, skipped: 1 });
  });
  it("names a course without a code by its name", () => {
    expect(courseFolderName({ name: "Seminar", courseCode: "" })).toBe("Seminar");
  });
});

describe("slugify", () => {
  it("makes lowercase ascii slugs", () => {
    expect(slugify("05 EM Waves & Optics")).toBe("05-em-waves-optics");
    expect(slugify("Café Déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!", "x")).toBe("x");
  });
});

describe("sha256", () => {
  it("matches published vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
  it("matches node:crypto however the input is chunked", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = new Uint8Array(randomBytes(length));
      const expected = createHash("sha256").update(data).digest("hex");
      const hash = new Sha256();
      for (let at = 0; at < data.length; ) {
        const step = 1 + Math.floor(Math.random() * 200);
        hash.update(data.subarray(at, at + step));
        at += step;
      }
      expect(hash.digest()).toBe(expected);
    }
  });
});

describe("render", () => {
  it("strips scripts and inline handlers, keeps the content", () => {
    const out = renderDocument(doc("page", "p", "T", { html: '<p onclick="x()">hi</p><script>alert(1)</script><a href="u" onmouseover=y>l</a>' }));
    expect(out).not.toMatch(/script|onclick|onmouseover/i);
    expect(out).toContain("hi");
    expect(out).toContain('href="u"');
  });
  it("escapes the title", () => {
    expect(renderDocument(doc("page", "p", "<b>&"))).toContain("<h1>&lt;b&gt;&amp;</h1>");
  });
});

describe("manifest", () => {
  const item = (over: Partial<PlannedItem> = {}): PlannedItem => ({
    source: "canvas:file/1", courseId: 7, path: ["a", "f.pdf"], size: 10, modifiedAt: "t1", url: "u", content: null, ...over,
  });
  const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({ path: ["a", "f.pdf"], size: 10, sha256: "h", modifiedAt: "t1", savedAt: "s", ...over });

  it("decides new / unchanged / changed", () => {
    expect(decide(item(), undefined)).toBe("new");
    expect(decide(item(), entry())).toBe("unchanged");
    expect(decide(item({ modifiedAt: "t2" }), entry())).toBe("changed");
    expect(decide(item({ size: 11 }), entry())).toBe("unchanged"); // time decides when present
    expect(decide(item({ modifiedAt: null, size: 11 }), entry({ modifiedAt: null }))).toBe("changed");
    expect(decide(item({ path: ["b", "f.pdf"] }), entry())).toBe("changed");
  });
  it("refetches a file deleted or truncated on disk, when disk was checked", () => {
    expect(decide(item(), entry(), 10)).toBe("unchanged");
    expect(decide(item(), entry(), null)).toBe("new");
    expect(decide(item(), entry(), 3)).toBe("changed");
  });
  it("compares inline items by content hash", () => {
    const text = item({ content: "<p>x</p>", url: null, modifiedAt: null });
    expect(decide(text, entry({ sha256: hashText("<p>x</p>"), modifiedAt: null }))).toBe("unchanged");
    expect(decide(text, entry({ sha256: hashText("<p>y</p>"), modifiedAt: null }))).toBe("changed");
  });
  it("treats missing, corrupt or foreign manifests as empty", () => {
    expect(parseManifest(null, 7).entries).toEqual({});
    expect(parseManifest("{nope", 7).entries).toEqual({});
    expect(parseManifest(JSON.stringify({ version: 1, courseId: 8, entries: { a: entry() } }), 7).entries).toEqual({});
    expect(parseManifest(JSON.stringify({ version: 1, courseId: 7, entries: { a: entry() } }), 7).entries).toHaveProperty("a");
  });
  it("builds the batch the ingest contract describes", () => {
    const at = new Date("2026-10-15T14:03:09.123Z");
    expect(batchFileName(at)).toBe("2026-10-15T140309.json");
    const batch = buildBatch(at, [{ course: "ece3030", source: "canvas:file/9", path: ["ece3030", "05-em", "l.pdf"], size: 4, sha256: "h", modifiedAt: "t" }], { ece3030: 99 });
    expect(batch).toEqual({
      createdAt: "2026-10-15T14:03:09.123Z",
      courses: { ece3030: 99 },
      files: [{ course: "ece3030", path: "ece3030/05-em/l.pdf", source: "canvas:file/9", canvasModifiedAt: "t", size: 4, sha256: "h" }],
    });
  });
});

/** An in-memory sink: files by path, text by path. */
function memorySink() {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const sink: FileSink = {
    keepsRecords: true,
    size: async (path) => (disk.has(path.join("/")) ? (disk.get(path.join("/")) as string).length : null),
    readText: async (path) => disk.get(path.join("/")) ?? null,
    writeText: async (path, text) => void disk.set(path.join("/"), text),
    save: async (item) => {
      calls.push(item.source);
      const text = item.content ?? `bytes of ${item.source}`;
      disk.set(item.path.join("/"), text);
      return { size: text.length, sha256: hashText(text) };
    },
  };
  return { sink, disk, calls };
}

function memoryStore(): ManifestStore & { data: Map<number, CourseManifest> } {
  const data = new Map<number, CourseManifest>();
  return {
    data,
    load: async (plan) => data.get(plan.courseId) ?? emptyManifest(plan.courseId),
    save: async (plan, manifest) => void data.set(plan.courseId, structuredClone(manifest)),
  };
}

describe("runArchive", () => {
  const sources = src({
    modules: [{ id: 1, name: "W1", position: 1, fileIds: [1, 2] }],
    files: [file(1, "a.pdf", { updatedAt: "t1" }), file(2, "b.pdf", { updatedAt: "t1" })],
    documents: [doc("page", "p", "Page")],
  });
  const plansFor = (s: CourseSources, layout: Layout = archiveLayout) => planCourses([{ course, sources: s }], layout);

  it("saves everything first, then nothing the second time", async () => {
    const { sink, calls } = memorySink();
    const store = memoryStore();
    const first = await runArchive(plansFor(sources), archiveLayout, sink, store);
    expect(first).toMatchObject({ saved: 3, unchanged: 0, failed: 0 });
    expect(Object.keys(store.data.get(7)?.entries ?? {}).sort()).toEqual(["canvas:file/1", "canvas:file/2", "canvas:page/p"]);

    calls.length = 0;
    const second = await runArchive(plansFor(sources), archiveLayout, sink, store);
    expect(second).toMatchObject({ saved: 0, unchanged: 3 });
    expect(calls).toEqual([]);
  });

  it("fetches only the changed and the new on a later run", async () => {
    const { sink, calls } = memorySink();
    const store = memoryStore();
    await runArchive(plansFor(sources), archiveLayout, sink, store);
    calls.length = 0;
    const later = src({
      ...sources,
      files: [file(1, "a.pdf", { updatedAt: "t1" }), file(2, "b.pdf", { updatedAt: "t2" }), file(3, "c.pdf", { updatedAt: "t1" })],
    });
    const result = await runArchive(plansFor(later), archiveLayout, sink, store);
    expect(result).toMatchObject({ saved: 2, unchanged: 2 });
    expect(calls.sort()).toEqual(["canvas:file/2", "canvas:file/3"]);
  });

  it("refetches a file the user deleted from the folder", async () => {
    const { sink, disk, calls } = memorySink();
    const store = memoryStore();
    await runArchive(plansFor(sources), archiveLayout, sink, store);
    disk.delete("Cornell/ECE 3140 Embedded Systems/01 W1/a.pdf");
    calls.length = 0;
    await runArchive(plansFor(sources), archiveLayout, sink, store);
    expect(calls).toEqual(["canvas:file/1"]);
  });

  it("checkpoints the manifest so an interrupted run keeps its progress", async () => {
    const many = src({ files: Array.from({ length: 60 }, (_, i) => file(i + 1, `f${i}.pdf`, { updatedAt: "t" })) });
    const { sink } = memorySink();
    const store = memoryStore();
    const controller = new AbortController();
    let saves = 0;
    const stopping: FileSink = {
      ...sink,
      save: async (item) => {
        if (++saves === 40) controller.abort();
        return sink.save(item);
      },
    };
    const result = await runArchive(plansFor(many), archiveLayout, stopping, store, { concurrency: 1, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(Object.keys(store.data.get(7)?.entries ?? {}).length).toBe(result.saved);
  });

  it("writes the ingest batch last, listing only what was saved", async () => {
    const { sink, disk } = memorySink();
    const store = memoryStore();
    const at = new Date("2026-10-15T14:03:09Z");
    const run = () => runArchive(plansFor(sources, ingestLayout), ingestLayout, sink, store, { now: () => at, runId: "aabbccdd" });
    const first = await run();
    expect(first.batch).toBe("2026-10-15T140309-aabbccdd.json");
    const batch = JSON.parse(disk.get("_batches/2026-10-15T140309-aabbccdd.json") as string);
    expect(batch.courses).toEqual({ ece3140: 7 });
    expect(batch.files.map((f: { source: string }) => f.source).sort()).toEqual(["canvas:file/1", "canvas:file/2", "canvas:page/p"]);
    expect(batch.files[0].path.startsWith("ece3140/")).toBe(true);

    disk.clear(); // HQ drained the inbox
    const second = await run();
    expect(second).toMatchObject({ saved: 0, unchanged: 3, batch: null });
    expect(disk.size).toBe(0);
  });

  it("continues past a failure and reports it without leaking the URL", async () => {
    const { sink } = memorySink();
    const failing: FileSink = {
      ...sink,
      save: async (item) => {
        if (item.source === "canvas:file/1") throw new Error("Canvas answered 403");
        return sink.save(item);
      },
    };
    const result = await runArchive(plansFor(sources), archiveLayout, failing, memoryStore());
    expect(result).toMatchObject({ saved: 2, failed: 1 });
    expect(result.outcomes.find((o) => o.status === "failed")).toMatchObject({ message: "Canvas answered 403" });
  });

  it("without records (Downloads fallback) it saves everything every time", async () => {
    const { sink, calls } = memorySink();
    const blind: FileSink = { ...sink, keepsRecords: false };
    await runArchive(plansFor(sources), archiveLayout, blind, memoryStore());
    await runArchive(plansFor(sources), archiveLayout, blind, memoryStore());
    expect(calls).toHaveLength(6);
  });

  it("detects an all-blocked run so the UI can offer the fallback", async () => {
    const { sink } = memorySink();
    const blocked: FileSink = { ...sink, save: async () => { throw new Error("blocked: nope"); } };
    expect(looksBlockedByCors(await runArchive(plansFor(sources), archiveLayout, blocked, memoryStore()))).toBe(true);
    const mixed: FileSink = {
      ...sink,
      save: async (item) => { throw new Error(item.source === "canvas:file/1" ? "Canvas answered 404" : "blocked: nope"); },
    };
    expect(looksBlockedByCors(await runArchive(plansFor(sources), archiveLayout, mixed, memoryStore()))).toBe(false);
  });
});

describe("document normalizers", () => {
  it("reads assignments, announcements, pages and syllabus", () => {
    expect(normalizeAssignment({ id: 5, name: "Lab", description: "<p>d</p>", updated_at: "t" })).toMatchObject({ kind: "assignment", key: "5", title: "Lab", html: "<p>d</p>" });
    expect(normalizeAnnouncement({ id: 6, title: "Hi", message: "m", posted_at: "p" })).toMatchObject({ kind: "announcement", key: "6", modifiedAt: "p" });
    expect(normalizePage({ url: "week-1", title: "W1", body: "b" })).toMatchObject({ kind: "page", key: "week-1" });
    expect(normalizeSyllabus(7, { syllabus_body: "<p>s</p>" })).toMatchObject({ kind: "syllabus", key: "7" });
    expect(normalizeSyllabus(7, { syllabus_body: "" })).toBeNull();
    expect(normalizePage({ title: "no slug" })).toBeNull();
  });
});

describe("normalizers", () => {
  it("reads a Canvas file, tolerating missing fields", () => {
    expect(normalizeFile({ id: 3, display_name: "Slides.pdf", filename: "slides.pdf", size: 9, url: "u", folder_id: 2, locked_for_user: true })).toMatchObject({
      id: 3, displayName: "Slides.pdf", filename: "slides.pdf", size: 9, folderId: 2, locked: true,
    });
    expect(normalizeFile({ display_name: "no id" })).toBeNull();
    expect(normalizeFile({ id: 1 })).toMatchObject({ displayName: "file-1", size: 0, url: null, locked: false });
  });
  it("collects only File items from a module", () => {
    expect(
      normalizeModule({ id: 1, name: "W1", position: 4, items: [{ type: "File", content_id: 10 }, { type: "Page", content_id: 11 }, { type: "File" }] }, 0),
    ).toEqual({ id: 1, name: "W1", position: 4, fileIds: [10] });
  });
});

describe("ingestCourseSlug", () => {
  it("reduces Canvas codes to the contract folder name", () => {
    const c = (courseCode: string, name = "Some Course") => ({ courseCode, name });
    expect(ingestCourseSlug(c("ECE 3030 FA26"))).toBe("ece3030");
    expect(ingestCourseSlug(c("CS3700-001"))).toBe("cs3700");
    expect(ingestCourseSlug(c("PE 1300"))).toBe("pe1300");
    expect(ingestCourseSlug(c("", "HIST 2369: Modern Europe"))).toBe("hist2369");
    expect(ingestCourseSlug(c("Orientation", "Orientation"))).toBe("orientation");
  });
});
