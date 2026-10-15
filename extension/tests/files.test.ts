import { describe, expect, it } from "vitest";
import { sanitizeFilename, sanitizeSegment, uniqueNames } from "@/src/files/paths";
import { courseFolderName, planCourse, planCourses, summarize, type CanvasFile } from "@/src/files/plan";
import { looksBlockedByCors, runPlan, type FileSink } from "@/src/files/runner";
import { normalizeFile, normalizeModule } from "@/src/files/api";

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

describe("planCourse", () => {
  it("lays files out as Cornell/<course>/<NN module>/<file>", () => {
    const plan = planCourse(
      course,
      [{ id: 1, name: "Week 1: Intro", position: 1, fileIds: [10] }],
      [file(10, "lec1.pdf")],
      [],
    );
    expect(plan.files.map((f) => f.path)).toEqual([["Cornell", "ECE 3140 Embedded Systems", "01 Week 1- Intro", "lec1.pdf"]]);
  });

  it("orders modules by position and prefixes so 10 sorts after 2", () => {
    const plan = planCourse(
      course,
      [
        { id: 2, name: "Week 10", position: 10, fileIds: [2] },
        { id: 1, name: "Week 2", position: 2, fileIds: [1] },
      ],
      [file(1, "a.pdf"), file(2, "b.pdf")],
      [],
    );
    expect(plan.files.map((f) => f.path[2])).toEqual(["02 Week 2", "10 Week 10"]);
  });

  it("places a file linked from two modules once, in the first", () => {
    const plan = planCourse(
      course,
      [
        { id: 1, name: "A", position: 1, fileIds: [5] },
        { id: 2, name: "B", position: 2, fileIds: [5] },
      ],
      [file(5, "shared.pdf")],
      [],
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.path[2]).toBe("01 A");
  });

  it("puts files outside any module under Course files, keeping Canvas folders", () => {
    const plan = planCourse(
      course,
      [],
      [file(1, "syllabus.pdf", { folderId: 1 }), file(2, "w1.pdf", { folderId: 2 })],
      [
        { id: 1, fullName: "course files" },
        { id: 2, fullName: "course files/Lectures/Week 1" },
      ],
    );
    expect(plan.files.map((f) => f.path.slice(2).join("/"))).toEqual([
      "Course files/Lectures/Week 1/w1.pdf",
      "Course files/syllabus.pdf",
    ]);
  });

  it("skips locked files and files with no URL, and says why", () => {
    const plan = planCourse(course, [], [file(1, "a.pdf", { locked: true }), file(2, "b.pdf", { url: null }), file(3, "c.pdf")], []);
    expect(plan.files.map((f) => f.fileId)).toEqual([3]);
    expect(plan.skipped).toEqual([
      { fileId: 1, name: "a.pdf", reason: "locked" },
      { fileId: 2, name: "b.pdf", reason: "no-url" },
    ]);
  });

  it("renames same-named files in one folder", () => {
    const plan = planCourse(course, [{ id: 1, name: "M", position: 1, fileIds: [1, 2] }], [file(1, "notes.pdf"), file(2, "Notes.pdf")], []);
    expect(plan.files.map((f) => f.path[3]).sort()).toEqual(["Notes (2).pdf", "notes.pdf"]);
  });

  it("ignores module file ids Canvas did not return (hidden or deleted)", () => {
    const plan = planCourse(course, [{ id: 1, name: "M", position: 1, fileIds: [99] }], [], []);
    expect(plan.files).toEqual([]);
  });

  it("never emits '..' or empty segments, whatever Canvas calls things", () => {
    const plan = planCourse(
      { id: 1, name: "..", courseCode: "" },
      [{ id: 1, name: "../../etc", position: 1, fileIds: [1] }],
      [file(1, "..")],
      [],
    );
    for (const segment of plan.files.flatMap((f) => f.path)) {
      expect(segment).not.toBe("..");
      expect(segment).not.toBe("");
      expect(segment).not.toContain("/");
    }
  });
});

describe("planCourses", () => {
  it("keeps two courses with the same name apart", () => {
    const plans = planCourses([
      { course, modules: [], files: [], folders: [] },
      { course: { ...course, id: 8 }, modules: [], files: [], folders: [] },
    ]);
    expect(plans.map((p) => p.folder)).toEqual(["ECE 3140 Embedded Systems", "ECE 3140 Embedded Systems (2)"]);
  });
  it("summarises counts and bytes", () => {
    const plan = planCourse(course, [], [file(1, "a.pdf", { size: 5 }), file(2, "b.pdf", { locked: true })], []);
    expect(summarize([plan])).toEqual({ courses: 1, files: 1, bytes: 5, skipped: 1 });
  });
  it("names a course without a code by its name", () => {
    expect(courseFolderName({ name: "Seminar", courseCode: "" })).toBe("Seminar");
  });
});

describe("runPlan", () => {
  const planned = ["a", "b", "c"].map((n, i) => ({
    fileId: i,
    courseId: 1,
    path: ["Cornell", `${n}.pdf`],
    size: 10,
    updatedAt: null,
    url: "https://canvas.cornell.edu/x",
  }));

  it("skips files already present and saves the rest", async () => {
    const saved: string[] = [];
    const sink: FileSink = {
      has: async (path) => path[1] === "a.pdf",
      save: async (f) => void saved.push(f.path[1] as string),
    };
    const result = await runPlan(planned, sink);
    expect(result).toMatchObject({ saved: 2, skipped: 1, failed: 0 });
    expect(saved.sort()).toEqual(["b.pdf", "c.pdf"]);
  });

  it("continues past a failure and reports it", async () => {
    const sink: FileSink = {
      has: async () => false,
      save: async (f) => {
        if (f.fileId === 1) throw new Error("Canvas answered 403");
      },
    };
    const result = await runPlan(planned, sink);
    expect(result).toMatchObject({ saved: 2, failed: 1 });
    expect(result.outcomes.find((o) => o.status === "failed")).toMatchObject({ message: "Canvas answered 403" });
  });

  it("stops starting new files after abort", async () => {
    const controller = new AbortController();
    const sink: FileSink = {
      has: async () => false,
      save: async () => controller.abort(),
    };
    const result = await runPlan(planned, sink, { concurrency: 1, signal: controller.signal });
    expect(result.saved).toBe(1);
    expect(result.cancelled).toBe(true);
  });

  it("detects an all-blocked run so the UI can offer the fallback", async () => {
    const blocked: FileSink = {
      has: async () => false,
      save: async () => {
        throw new Error("blocked: nope");
      },
    };
    expect(looksBlockedByCors(await runPlan(planned, blocked))).toBe(true);

    const mixed: FileSink = {
      has: async () => false,
      save: async (f) => {
        if (f.fileId === 0) throw new Error("Canvas answered 404");
        throw new Error("blocked: nope");
      },
    };
    expect(looksBlockedByCors(await runPlan(planned, mixed))).toBe(false);
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
