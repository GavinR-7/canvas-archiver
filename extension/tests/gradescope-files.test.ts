import { describe, expect, it, vi } from "vitest";
import { listGradescopeFiles, matchCanvasCourse, parseHandouts, withGradescope } from "@/src/gradescope/files";
import { parseCourses } from "@/src/gradescope/parse";
import { archiveLayout, ingestLayout } from "@/src/files/layout";
import { decide, type ManifestEntry } from "@/src/files/manifest";
import { planCourses, type CourseSources, type PlannedItem } from "@/src/files/plan";
import { runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";
import { emptyManifest } from "@/src/files/manifest";
import { ACCOUNT_PAGE, COURSE_PAGE } from "./fixtures/gradescope-markup";
import { ASSIGNMENT_WITH_HANDOUTS, ASSIGNMENT_WITHOUT_FILES } from "./fixtures/gradescope-files-markup";

const empty: CourseSources = { modules: [], files: [], folders: [], documents: [] };

describe("parseHandouts", () => {
  const files = parseHandouts(ASSIGNMENT_WITH_HANDOUTS, 900001, 5550001, "Project 1 & Setup");

  it("finds the assignment PDF and the attachment, once each", () => {
    expect(files.map((f) => f.filename)).toEqual(["Project 1 Spec.pdf", "Starter handout.pdf"]);
  });

  it("builds absolute Gradescope URLs without the query string", () => {
    expect(files[0]?.url).toBe("https://www.gradescope.com/courses/900001/assignments/5550001/files/Project%201%20Spec.pdf");
    expect(files[1]?.url).toBe("https://www.gradescope.com/courses/900001/assignments/5550001/attachments/77/download");
  });

  it("ignores the student's own submission, other assignments, other hosts and non-file links", () => {
    const urls = files.map((f) => f.url).join(" ");
    expect(urls).not.toMatch(/submissions|5550002|evil|review_grades/);
  });

  it("gives stable source ids and fingerprints", () => {
    expect(files[0]?.source).toBe("gradescope:file/5550001/assignments_5550001_files_Project%201%20Spec.pdf");
    expect(files[0]?.fingerprint).toBe("/courses/900001/assignments/5550001/files/Project%201%20Spec.pdf");
  });

  it("returns nothing for a page with no handouts, junk or empty input", () => {
    expect(parseHandouts(ASSIGNMENT_WITHOUT_FILES, 900001, 5550003, "Quiz 4")).toEqual([]);
    expect(parseHandouts("", 900001, 1, "x")).toEqual([]);
    expect(parseHandouts("<a href='http://[bad'>x</a>", 900001, 1, "x")).toEqual([]);
  });
});

describe("matchCanvasCourse", () => {
  const canvas = [
    { id: 1, name: "Operating Systems", courseCode: "CS 3700 FA26" },
    { id: 2, name: "Embedded Systems", courseCode: "ECE 3140" },
  ];

  it("matches by department and number, ignoring spacing and suffix", () => {
    expect(matchCanvasCourse({ shortName: "CS3700", name: "x" }, canvas)?.id).toBe(1);
    expect(matchCanvasCourse({ shortName: "ECE 3140", name: "x" }, canvas)?.id).toBe(2);
  });

  it("does not guess when nothing or two courses match", () => {
    expect(matchCanvasCourse({ shortName: "MATH 1920", name: "Calc" }, canvas)).toBeNull();
    expect(matchCanvasCourse({ shortName: "CS 3700", name: "x" }, [...canvas, { id: 3, name: "x", courseCode: "CS 3700" }])).toBeNull();
    expect(matchCanvasCourse({ shortName: "Seminar", name: "Seminar" }, canvas)).toBeNull();
  });
});

describe("listGradescopeFiles", () => {
  const courses = parseCourses(ACCOUNT_PAGE).slice(0, 1);

  it("reads each assignment page and collects handouts", async () => {
    const getPage = vi.fn(async (path: string) => (path === "/courses/900001" ? COURSE_PAGE : ASSIGNMENT_WITH_HANDOUTS));
    const listing = await listGradescopeFiles(courses, getPage);
    expect(listing.errors).toEqual([]);
    expect(listing.courses[0]?.files.length).toBeGreaterThan(0);
    expect(getPage.mock.calls[0]?.[0]).toBe("/courses/900001");
    expect(getPage.mock.calls.slice(1).every(([p]) => p.startsWith("/courses/900001/assignments/"))).toBe(true);
  });

  it("isolates a failing assignment page: the rest still list", async () => {
    let n = 0;
    const getPage = async (path: string) => {
      if (path === "/courses/900001") return COURSE_PAGE;
      if (n++ === 0) throw new Error("Gradescope returned 500");
      return ASSIGNMENT_WITH_HANDOUTS;
    };
    const listing = await listGradescopeFiles(courses, getPage);
    expect(listing.errors).toHaveLength(1);
    expect(listing.errors[0]).toMatch(/500/);
    expect(listing.courses[0]?.files.length).toBeGreaterThan(0);
  });

  it("records a failing course page and moves on", async () => {
    const listing = await listGradescopeFiles(parseCourses(ACCOUNT_PAGE).slice(0, 2), async (path) => {
      if (path === "/courses/900001") throw new Error("boom");
      return path === "/courses/900002" ? COURSE_PAGE : ASSIGNMENT_WITHOUT_FILES;
    });
    expect(listing.errors[0]).toMatch(/boom/);
    expect(listing.courses.map((c) => c.course.id)).toEqual([900002]);
  });

  it("stops between pages when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getPage = vi.fn(async () => COURSE_PAGE);
    expect((await listGradescopeFiles(courses, getPage, controller.signal)).courses).toEqual([]);
    expect(getPage).not.toHaveBeenCalled();
  });
});

describe("withGradescope and planning", () => {
  const gs = parseCourses(ACCOUNT_PAGE)[0]!; // CS 3700
  const handouts = parseHandouts(ASSIGNMENT_WITH_HANDOUTS, gs.id, 5550001, "Project 1");
  const listing = { courses: [{ course: gs, files: handouts }], errors: [] };
  const canvasCourse = { id: 7, name: "Operating Systems", courseCode: "CS 3700" };

  it("puts handouts into the matching Canvas course's Gradescope folder", () => {
    const merged = withGradescope([{ course: canvasCourse, sources: empty }], listing);
    expect(merged).toHaveLength(1);
    const [plan] = planCourses(merged, archiveLayout);
    expect(plan?.items.map((i) => i.path.slice(-2))).toEqual([
      ["Gradescope", "Project 1 Spec.pdf"],
      ["Gradescope", "Starter handout.pdf"],
    ]);
    expect(plan?.items.every((i) => i.session === "gradescope" && i.url?.startsWith("https://www.gradescope.com/"))).toBe(true);
  });

  it("gives an unmatched Gradescope course its own folder under a negative id", () => {
    const merged = withGradescope([], listing);
    expect(merged[0]?.course.id).toBe(-gs.id);
    const [plan] = planCourses(merged, archiveLayout);
    expect(plan?.dir[0]).toBe("Cornell");
    expect(plan?.items).toHaveLength(2);
  });

  it("uses files/ in the ingest layout", () => {
    const [plan] = planCourses(withGradescope([{ course: canvasCourse, sources: empty }], listing), ingestLayout);
    expect(plan?.items[0]?.path.slice(-2)).toEqual(["files", "Project 1 Spec.pdf"]);
  });

  it("changes nothing when there are no handouts or no listing", () => {
    const inputs = [{ course: canvasCourse, sources: empty }];
    const merged = withGradescope(inputs, { courses: [{ course: gs, files: [] }], errors: ["x"] });
    expect(merged).toHaveLength(1);
    expect(planCourses(merged, archiveLayout)[0]?.items).toEqual([]);
  });

  it("does not mutate its input", () => {
    const inputs = [{ course: canvasCourse, sources: empty }];
    withGradescope(inputs, listing);
    expect(inputs[0]?.sources.external).toBeUndefined();
  });
});

describe("manifest decision for Gradescope items", () => {
  const item: PlannedItem = {
    source: "gradescope:file/1/x",
    courseId: 7,
    path: ["Cornell", "CS", "Gradescope", "a.pdf"],
    size: 0,
    modifiedAt: null,
    url: "https://www.gradescope.com/courses/1/assignments/1/files/a.pdf",
    content: null,
    session: "gradescope",
    fingerprint: "/courses/1/assignments/1/files/a.pdf",
  };
  const entry: ManifestEntry = { path: item.path, size: 52341, sha256: null, modifiedAt: null, savedAt: "t", fingerprint: item.fingerprint };

  it("skips a saved file whose fingerprint is unchanged, whatever its byte size", () => {
    expect(decide(item, entry)).toBe("unchanged");
  });

  it("re-fetches when the URL path changes, the file moves, or it is new", () => {
    expect(decide({ ...item, fingerprint: "/courses/1/assignments/1/files/b.pdf" }, entry)).toBe("changed");
    expect(decide({ ...item, path: ["x", "a.pdf"] }, entry)).toBe("changed");
    expect(decide(item, undefined)).toBe("new");
  });
});

describe("runArchive with Gradescope items", () => {
  it("saves once, then skips on the second run, and a failed item does not stop the others", async () => {
    const merged = withGradescope([], {
      courses: [{ course: parseCourses(ACCOUNT_PAGE)[0]!, files: parseHandouts(ASSIGNMENT_WITH_HANDOUTS, 900001, 5550001, "P1") }],
      errors: [],
    });
    const plans = planCourses(merged, archiveLayout);
    const saved: string[] = [];
    let failedOnce = false;
    const sink: FileSink = {
      keepsRecords: true,
      size: async () => null,
      readText: async () => null,
      writeText: async () => undefined,
      save: async (item) => {
        if (item.path.at(-1) === "Starter handout.pdf" && !failedOnce) {
          failedOnce = true;
          throw new Error("Gradescope answered 500");
        }
        saved.push(item.source);
        return { size: 10, sha256: "h" };
      },
    };
    const store: Record<number, ReturnType<typeof emptyManifest>> = {};
    const manifests: ManifestStore = {
      load: async (plan) => store[plan.courseId] ?? emptyManifest(plan.courseId),
      save: async (plan, m) => void (store[plan.courseId] = m),
    };

    // verifyDisk is on for the archive layout and the stub reports "absent" as null, so use a layout that trusts the manifest
    const trusting = { ...archiveLayout, verifyDisk: false };
    const first = await runArchive(plans, trusting, sink, manifests);
    expect([first.saved, first.failed]).toEqual([1, 1]);

    const second = await runArchive(plans, trusting, sink, manifests);
    expect([second.saved, second.unchanged, second.failed]).toEqual([1, 1, 0]);
    const third = await runArchive(plans, trusting, sink, manifests);
    expect([third.saved, third.unchanged]).toEqual([0, 2]);
  });
});
