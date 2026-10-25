import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGradescopeFiles } from "@/src/gradescope/api";
import { conditionalHeaders, validatorOf } from "@/src/files/sinks";
import { listGradescopeFiles, matchCanvasCourse, parseHandouts, withGradescope } from "@/src/gradescope/files";
import { parseCourses } from "@/src/gradescope/parse";
import { archiveLayout, ingestLayout } from "@/src/files/layout";
import { decide, hashText, type CourseManifest, type ManifestEntry } from "@/src/files/manifest";
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

  it("gives stable source ids", () => {
    expect(files[0]?.source).toBe("gradescope:file/5550001/assignments_5550001_files_Project%201%20Spec.pdf");
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
  };
  const entry: ManifestEntry = { path: item.path, size: 52341, sha256: "aa", modifiedAt: null, savedAt: "t", validator: 'etag:"v1"' };

  it("never trusts the URL as a version: a known file is revalidated with the host", () => {
    expect(decide(item, entry)).toBe("revalidate");
  });

  it("re-files a moved file, fetches a new one, and re-fetches a file deleted from disk", () => {
    expect(decide({ ...item, path: ["x", "a.pdf"] }, entry)).toBe("changed");
    expect(decide(item, undefined)).toBe("new");
    expect(decide(item, entry, null)).toBe("new");
  });
});

describe("validators", () => {
  it("prefers ETag, then Last-Modified, and does not trust Content-Length alone", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
    expect(validatorOf(h({ etag: '"v1"', "last-modified": "x" }))).toBe('etag:"v1"');
    expect(validatorOf(h({ "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toBe("lm:Wed, 21 Oct 2026 07:28:00 GMT");
    expect(validatorOf(h({ "content-length": "10" }))).toBeNull();
  });

  it("turns a saved validator into the matching conditional header", () => {
    expect(conditionalHeaders('etag:"v1"')).toEqual({ "If-None-Match": '"v1"' });
    expect(conditionalHeaders("lm:Wed")).toEqual({ "If-Modified-Since": "Wed" });
    expect(conditionalHeaders(null)).toEqual({});
    expect(conditionalHeaders(undefined)).toEqual({});
  });
});

describe("a handout replaced in place at the same URL", () => {
  const listing = {
    courses: [{ course: parseCourses(ACCOUNT_PAGE)[0]!, files: parseHandouts(ASSIGNMENT_WITH_HANDOUTS, 900001, 5550001, "P1").slice(0, 1) }],
    errors: [],
  };
  const trusting = { ...archiveLayout, verifyDisk: false };

  /** A host whose file at one URL can change; the sink answers like the folder sink does. */
  function host() {
    const state = { body: "v1", etag: '"e1"', sends: [] as (string | undefined)[], useEtag: true };
    const sink: FileSink = {
      keepsRecords: true,
      size: async () => null,
      readText: async () => null,
      writeText: async () => undefined,
      save: async (_item, prior) => {
        state.sends.push(prior?.validator ?? undefined);
        const validator = state.useEtag ? `etag:${state.etag}` : null;
        if (state.useEtag && prior?.validator === validator) {
          return { size: prior.size, sha256: prior.sha256, validator: prior.validator, notModified: true };
        }
        return { size: state.body.length, sha256: hashText(state.body), validator };
      },
    };
    return { state, sink };
  }

  async function runTwice(configure: (s: ReturnType<typeof host>["state"]) => void) {
    const { state, sink } = host();
    const plans = planCourses(withGradescope([], listing), archiveLayout);
    const store: Record<number, CourseManifest> = {};
    const manifests: ManifestStore = {
      load: async (p) => store[p.courseId] ?? emptyManifest(p.courseId),
      save: async (p, m) => void (store[p.courseId] = m),
    };
    const first = await runArchive(plans, trusting, sink, manifests);
    configure(state);
    const second = await runArchive(plans, trusting, sink, manifests);
    return { first, second, state };
  }

  it("is re-downloaded when the host's ETag changed", async () => {
    const { first, second, state } = await runTwice((s) => {
      s.body = "v2 new content";
      s.etag = '"e2"';
    });
    expect(first.saved).toBe(1);
    expect(second).toMatchObject({ saved: 1, unchanged: 0 });
    expect(state.sends).toEqual([undefined, 'etag:"e1"']); // the second run asked conditionally
  });

  it("costs a 304 and writes nothing when the ETag is unchanged", async () => {
    const { second } = await runTwice(() => undefined);
    expect(second).toMatchObject({ saved: 0, unchanged: 1 });
  });

  it("with no validator from the host, re-fetches and compares the hash: changed bytes are saved", async () => {
    const { second } = await runTwice((s) => {
      s.useEtag = false;
      s.body = "v2 new content";
    });
    expect(second).toMatchObject({ saved: 1, unchanged: 0 });
  });

  it("with no validator and identical bytes, reports unchanged", async () => {
    const { second } = await runTwice((s) => {
      s.useEtag = false;
    });
    expect(second).toMatchObject({ saved: 0, unchanged: 1 });
  });
});

describe("fetchGradescopeFiles is bounded", () => {
  afterEach(() => vi.unstubAllGlobals());
  const page = (html: string) => new Response(html, { status: 200 });

  it("returns after the budget when the first request never settles (and ignores the abort)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    const started = Date.now();
    const listing = await fetchGradescopeFiles(new Date("2026-10-01"), undefined, 80);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(listing.courses).toEqual([]);
    expect(listing.errors.join(" ")).toMatch(/did not answer/);
  });

  it("aborts the in-flight request at the budget when fetch honours the signal", async () => {
    let aborted = false;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );
    const listing = await fetchGradescopeFiles(new Date("2026-10-01"), undefined, 80);
    expect(aborted).toBe(true);
    expect(listing.errors.length).toBeGreaterThan(0);
  });

  it("keeps what it read before a later page hangs", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/account") return Promise.resolve(page(ACCOUNT_PAGE));
      if (path === "/courses/900001") return Promise.resolve(page(COURSE_PAGE));
      return new Promise(() => undefined);
    });
    const listing = await fetchGradescopeFiles(new Date("2026-10-01"), undefined, 150);
    expect(listing.errors.join(" ")).toMatch(/did not answer/);
    expect(listing.courses).toEqual([]); // the course being read is dropped whole, not half-listed
  });

  it("passes a request timeout signal to every Gradescope fetch", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(init.signal ?? undefined);
      return Promise.resolve(page("<html>Log In</html>"));
    });
    await fetchGradescopeFiles(new Date("2026-10-01"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s !== undefined)).toBe(true);
  });
});
