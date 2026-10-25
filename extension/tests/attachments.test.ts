import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/canvas/client", () => ({ getAll: vi.fn(), getOne: vi.fn() }));

import { getAll, getOne } from "@/src/canvas/client";
import { AccessDeniedError, NotFoundError } from "@/src/canvas/errors";
import { fetchCourseSources, fetchMissingFiles, normalizeAnnouncement, normalizeAssignment, normalizeDiscussion, normalizePage, normalizeSyllabus } from "@/src/files/api";
import { attachmentIds, fileIdsIn, relativeLink, rewriteFileLinks } from "@/src/files/attachments";
import { buildTree, itemsUnder } from "@/src/files/browse";
import { archiveLayout, ingestLayout } from "@/src/files/layout";
import { emptyManifest, hashText, type CourseManifest } from "@/src/files/manifest";
import { planCourse, type CanvasDocument, type CanvasFile, type CourseSources } from "@/src/files/plan";
import { runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";

const course = { id: 7, name: "Electromagnetic Fields", courseCode: "ECE 3030" };
const file = (id: number, name: string, extra: Partial<CanvasFile> = {}): CanvasFile => ({
  id, displayName: name, filename: name.replace(/ /g, "+"), size: 100, updatedAt: "t1", url: `https://canvas.example/files/${id}/download?verifier=x`, folderId: null, locked: false, ...extra,
});
const stub = `<p>Do it.</p><p><a class="instructure_file_link" href="https://canvas.cornell.edu/courses/7/files/101?wrap=1" data-api-endpoint="https://canvas.cornell.edu/api/v1/courses/7/files/101">Homework7-1.pdf</a></p>`;
const hw = (over: Partial<CanvasDocument> = {}): CanvasDocument => ({
  kind: "assignment", key: "55", title: "Homework 7", html: stub, modifiedAt: "t1", htmlUrl: null, attachmentIds: [101], ...over,
});
const sources = (over: Partial<CourseSources> = {}): CourseSources => ({ modules: [], files: [], folders: [], documents: [], ...over });

describe("finding attachments", () => {
  it("reads file ids from href and data-api-endpoint, once each, in order", () => {
    const html = `<a href="/courses/7/files/9/download?download_frd=1">a</a><a href="https://x/y" data-api-endpoint="https://c/api/v1/courses/7/files/4">b</a><a href="/courses/7/files/9">again</a><a href="/courses/7/pages/files-12">p</a>`;
    expect(fileIdsIn(html)).toEqual([9, 4]);
  });
  it("ignores images and plain text; only links are attachments", () => {
    expect(fileIdsIn(`<img src="/courses/7/files/3/preview"> see /files/5`)).toEqual([]);
  });
  it("puts the API attachments array first, then HTML links, without repeats", () => {
    expect(attachmentIds([{ id: 4 }, { id: 9 }, { nope: 1 }], `<a href="/files/9">x</a><a href="/files/12">y</a>`)).toEqual([4, 9, 12]);
  });
  it("the normalizers carry the ids", () => {
    expect(normalizeAssignment({ id: 55, name: "HW", description: stub })?.attachmentIds).toEqual([101]);
    expect(normalizeAnnouncement({ id: 1, title: "A", message: "", attachments: [{ id: 8 }] })?.attachmentIds).toEqual([8]);
    expect(normalizeDiscussion({ id: 2, title: "D", message: "<a href='/files/6'>f</a>" })).toMatchObject({ kind: "discussion", attachmentIds: [6] });
    expect(normalizePage({ url: "p", body: "<a href=\"/files/3\">f</a>" })?.attachmentIds).toEqual([3]);
    expect(normalizeSyllabus(7, { syllabus_body: stub })?.attachmentIds).toEqual([101]);
  });
});

describe("relative links", () => {
  it("links to a sibling, up and across, and encodes names", () => {
    expect(relativeLink(["C", "Assignments"], ["C", "Assignments", "Homework 7.pdf"])).toBe("Homework%207.pdf");
    expect(relativeLink(["C", "Assignments"], ["C", "01 Week 1", "a.pdf"])).toBe("../01%20Week%201/a.pdf");
  });
  it("rewrites only linked saved files and keeps the Canvas address", () => {
    const out = rewriteFileLinks(`<a href="/courses/7/files/1?wrap=1">one</a><a href="/courses/7/files/2">two</a>`, new Map([[1, "a%20b.pdf"]]));
    expect(out).toContain(`<a data-canvas-href="/courses/7/files/1?wrap=1" href="a%20b.pdf">one</a>`);
    expect(out).toContain(`<a href="/courses/7/files/2">two</a>`);
  });
});

describe("planning attachments", () => {
  it("saves the attachment beside the page under its original name and links the stub to it", () => {
    const plan = planCourse(course, sources({ files: [file(101, "Homework7-1.pdf")], documents: [hw()] }));
    const paths = plan.items.map((i) => i.path.slice(2).join("/"));
    expect(paths).toEqual(["Assignments/Homework 7.html", "Assignments/Homework7-1.pdf"]);
    const page = plan.items.find((i) => i.source === "canvas:assignment/55");
    expect(page?.content).toContain(`href="Homework7-1.pdf"`);
    expect(page?.content).toContain(`data-canvas-href=`);
  });
  it("keeps spaces in the original name (Canvas's filename field has plus signs)", () => {
    const plan = planCourse(course, sources({ files: [file(101, "Homework 7 solutions.pdf")], documents: [hw()] }));
    expect(plan.items.map((i) => i.path[3])).toContain("Homework 7 solutions.pdf");
    expect(plan.items.find((i) => i.content)?.content).toContain(`href="Homework%207%20solutions.pdf"`);
  });
  it("puts a file in its module when it is in one, and links across folders", () => {
    const plan = planCourse(course, sources({
      modules: [{ id: 1, name: "Week 1", position: 1, fileIds: [101] }],
      files: [file(101, "Homework7-1.pdf")],
      documents: [hw()],
    }));
    expect(plan.items.filter((i) => i.url)).toHaveLength(1);
    expect(plan.items.find((i) => i.url)?.path.slice(2)).toEqual(["01 Week 1", "Homework7-1.pdf"]);
    expect(plan.items.find((i) => i.content)?.content).toContain(`href="../01%20Week%201/Homework7-1.pdf"`);
  });
  it("saves a file named by two pages once, beside the first, and links both", () => {
    const plan = planCourse(course, sources({
      files: [file(101, "Homework7-1.pdf")],
      documents: [hw(), hw({ kind: "announcement", key: "9", title: "Reminder" })],
    }));
    expect(plan.items.filter((i) => i.url)).toHaveLength(1);
    const notice = plan.items.find((i) => i.source === "canvas:announcement/9");
    expect(notice?.content).toContain(`href="../Assignments/Homework7-1.pdf"`);
  });
  it("syllabus attachments land in Syllabus; the ingest layout keeps them in one folder", () => {
    const syl: CanvasDocument = { kind: "syllabus", key: "7", title: "Syllabus", html: stub, modifiedAt: null, htmlUrl: null, attachmentIds: [101] };
    const a = planCourse(course, sources({ files: [file(101, "ECE_3030_Syllabus_2026.pdf")], documents: [syl] }));
    expect(a.items.map((i) => i.path.slice(2).join("/"))).toEqual(["Syllabus/ECE_3030_Syllabus_2026.pdf", "Syllabus/Syllabus.html"]);
    const b = planCourse(course, sources({ files: [file(101, "ECE_3030_Syllabus_2026.pdf")], documents: [syl] }), ingestLayout);
    expect(b.items.map((i) => i.path.slice(1).join("/"))).toEqual(["_syllabus/ECE_3030_Syllabus_2026.pdf", "_syllabus/syllabus-syllabus.html"]);
  });
  it("leaves the link alone and says why when the file is locked or could not be fetched", () => {
    const plan = planCourse(course, sources({
      files: [file(101, "Homework7-1.pdf", { locked: true })],
      documents: [hw({ attachmentIds: [101, 102] })],
      unresolvedFileIds: [102],
    }));
    expect(plan.items.map((i) => i.source)).toEqual(["canvas:assignment/55"]);
    expect(plan.items[0]?.content).toContain(`href="https://canvas.cornell.edu/courses/7/files/101?wrap=1"`);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["locked", "unavailable"]);
  });
  it("renames a page and an attachment that would share a name", () => {
    const plan = planCourse(course, sources({ files: [file(101, "Homework 7.html")], documents: [hw()] }));
    expect(plan.items.map((i) => i.path[3]).sort()).toEqual(["Homework 7 (2).html", "Homework 7.html"]);
  });
  it("lists attachments in the course browser tree next to their page", () => {
    const plan = planCourse(course, sources({ files: [file(101, "Homework7-1.pdf")], documents: [hw()] }));
    const folder = buildTree(plan).folders.find((f) => f.name === "Assignments");
    expect(folder?.files.map((f) => f.name)).toEqual(["Homework 7.html", "Homework7-1.pdf"]);
    expect(itemsUnder(buildTree(plan))).toHaveLength(2);
  });
});

function runner() {
  const fetched: string[] = [];
  const written: string[] = [];
  const disk = new Map<string, number>();
  const sink: FileSink = {
    keepsRecords: true,
    size: async (path) => disk.get(path.join("/")) ?? null,
    save: async (item) => {
      (item.url ? fetched : written).push(item.source);
      const text = item.content ?? `bytes of ${item.source}`;
      disk.set(item.path.join("/"), text.length);
      return { size: text.length, sha256: hashText(text) };
    },
    readText: async () => null,
    writeText: async () => {},
  };
  const data = new Map<number, CourseManifest>();
  const store: ManifestStore = {
    load: async (p) => data.get(p.courseId) ?? emptyManifest(p.courseId),
    save: async (p, m) => void data.set(p.courseId, structuredClone(m)),
  };
  return { sink, store, fetched, written };
}

describe("incremental archive of attachments", () => {
  it("downloads the attachment once, then skips it while size and date are unchanged, and fetches it again when it changes", async () => {
    const { sink, store, fetched } = runner();
    const plans = (f: CanvasFile) => [planCourse(course, sources({ files: [f], documents: [hw()] }))];
    const first = await runArchive(plans(file(101, "Homework7-1.pdf")), archiveLayout, sink, store);
    expect(first).toMatchObject({ saved: 2, failed: 0 });
    expect(fetched).toEqual(["canvas:file/101"]);
    fetched.length = 0;
    const again = await runArchive(plans(file(101, "Homework7-1.pdf")), archiveLayout, sink, store);
    expect(again).toMatchObject({ saved: 0, unchanged: 2 });
    expect(fetched).toEqual([]);
    const changed = await runArchive(plans(file(101, "Homework7-1.pdf", { updatedAt: "t2", size: 250 })), archiveLayout, sink, store);
    expect(changed.saved).toBe(1);
    expect(fetched).toEqual(["canvas:file/101"]);
  });
});

describe("fetching files the Files list did not return", () => {
  beforeEach(() => vi.clearAllMocks());
  const raw = (id: number, name: string) => ({ id, display_name: name, filename: name, size: 5, url: `https://canvas.example/files/${id}/download` });

  it("asks for each unknown id, falls back to /files/<id>, and reports the ones Canvas refuses", async () => {
    vi.mocked(getOne).mockImplementation(async (path: string) => {
      if (path === "/courses/7/files/1") return raw(1, "a.pdf");
      if (path === "/courses/7/files/2") throw new NotFoundError("x");
      if (path === "/files/2") return raw(2, "b.pdf");
      throw new AccessDeniedError("no");
    });
    const out = await fetchMissingFiles(7, [1, 2, 3]);
    expect(out.files.map((f) => f.displayName)).toEqual(["a.pdf", "b.pdf"]);
    expect(out.unresolved).toEqual([3]);
  });

  it("fetchCourseSources pulls module and page files even when the Files tab is empty", async () => {
    vi.mocked(getAll).mockImplementation(async (path: string) => {
      if (path === "/courses/7/modules") return [{ id: 1, name: "W1", position: 1, items: [{ type: "File", content_id: 5 }] }];
      if (path === "/courses/7/assignments") return [{ id: 55, name: "HW", description: stub }];
      if (path === "/courses/7/discussion_topics") return [{ id: 3, title: "Q", message: "", attachments: [{ id: 6 }] }];
      return [];
    });
    vi.mocked(getOne).mockImplementation(async (path: string) => {
      const id = Number(/files\/(\d+)$/.exec(path)?.[1]);
      if (id) return raw(id, `f${id}.pdf`);
      return {};
    });
    const out = await fetchCourseSources(7);
    expect(out.files.map((f) => f.id).sort((a, b) => a - b)).toEqual([5, 6, 101]);
    expect(out.documents.map((d) => d.kind).sort()).toEqual(["assignment", "discussion"]);
    expect(out.unresolvedFileIds).toEqual([]);
  });
});
