import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/src/types/canvas";
import { extractExamDates, type DateCandidate } from "@/src/dates/extract";
import { syllabusFileTasks, type SyllabusFile, type SyllabusFileDeps } from "@/src/dates/syllabus-files";
import { fetchEdTasks } from "@/src/ed/api";

const NOW = new Date("2026-09-10T16:00:00Z");
const course = { id: 7, name: "Electromagnetic Fields", courseCode: "ECE 3030", htmlUrl: "https://canvas.cornell.edu/courses/7" } as Course;

// The shape pdf text takes: a short label, then the date and time on the next line.
const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const ECE_3030 = `ECE 3030 Fall 2026 Syllabus
Grading: Prelim 1 20%, Prelim 2 20%, Final Exam 35%
Prelim 1
Thursday, October 8, 7:30 PM - 9:00 PM
Prelim 2
Thursday, November 12, 7:30 PM
Final Exam
To be announced by the registrar`;

// A CS-style schedule table, one row per line after table extraction.
const CS_TABLE = `Week | Date | Topic
5 | Sep 29 | Search
7 | Oct 13 | Prelim 1 (in class)
13 | Dec 1 | Prelim 2 | 7:30pm
Finals | Dec 15 | Final exam, 2 PM`;

describe("exam dates from syllabus text", () => {
  it("reads the label-then-date layout a PDF produces, and invents nothing for a final with no date", () => {
    const found = extractExamDates(ECE_3030, NOW);
    expect(found.map((c) => c.title)).toEqual(expect.arrayContaining([expect.stringMatching(/Prelim 1/), expect.stringMatching(/Prelim 2/)]));
    // 7:30 PM EDT on Oct 8 is 23:30Z
    expect(found.find((c) => c.at.startsWith("2026-10-08"))?.at).toBe("2026-10-08T23:30:00.000Z");
    expect(found.map((c) => day(c.at))).toContain("2026-11-12");
    expect(found.some((c) => /final/i.test(c.title) && !/%/.test(c.evidence))).toBe(false);
    // The grading line names no date, so the exam words in it produce nothing.
    expect(found.every((c) => !c.evidence.includes("20%"))).toBe(true);
  });

  it("reads a schedule table row by row", () => {
    const found = extractExamDates(CS_TABLE, NOW);
    expect(found.map((c) => day(c.at)).sort()).toEqual(["2026-10-13", "2026-12-01", "2026-12-15"]);
  });
});

function deps(files: SyllabusFile[], read: (f: SyllabusFile) => Promise<string | null>) {
  const store = new Map<string, DateCandidate[]>();
  const readText = vi.fn(read);
  const d: SyllabusFileDeps = {
    listFiles: async () => files,
    readText,
    cache: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
  };
  return { d, readText, store };
}

describe("syllabusFileTasks", () => {
  const file: SyllabusFile = { id: 11, name: "ECE3030 Syllabus.pdf", updatedAt: "2026-08-20T10:00:00Z", url: "https://canvas.cornell.edu/files/11/download?verifier=x" };

  it("turns file dates into unconfirmed syllabus tasks linked to the file", async () => {
    const { d } = deps([file], async () => ECE_3030);
    const { tasks, unreadable } = await syllabusFileTasks([course], 240, d, NOW);
    expect(unreadable).toBe(0);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.every((t) => t.source === "syllabus" && t.unconfirmed === true && t.courseId === 7)).toBe(true);
    expect(tasks[0]?.htmlUrl).toBe("https://canvas.cornell.edu/courses/7/files/11");
  });

  it("reads a file once per modified time, and again when it changes", async () => {
    const { d, readText } = deps([file], async () => ECE_3030);
    await syllabusFileTasks([course], 240, d, NOW);
    await syllabusFileTasks([course], 240, d, NOW);
    expect(readText).toHaveBeenCalledTimes(1);
    const changed = { ...d, listFiles: async () => [{ ...file, updatedAt: "2026-09-01T00:00:00Z" }] };
    await syllabusFileTasks([course], 240, changed, NOW);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("counts a file it cannot read instead of guessing, and skips unsupported types", async () => {
    const { d, readText } = deps([file, { ...file, id: 12, name: "photo.png" }], async () => null);
    const { tasks, unreadable } = await syllabusFileTasks([course], 240, d, NOW);
    expect(tasks).toEqual([]);
    expect(unreadable).toBe(1);
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("keeps dates outside the window out", async () => {
    const { d } = deps([file], async () => ECE_3030);
    expect((await syllabusFileTasks([course], 10, d, NOW)).tasks).toEqual([]);
  });
});

describe("Ed: one notice per sync", () => {
  afterEach(() => vi.unstubAllGlobals());
  const courses = [
    { id: 1, name: "A", courseCode: "ECE 3030", htmlUrl: "" },
    { id: 2, name: "B", courseCode: "CS 3700", htmlUrl: "" },
    { id: 3, name: "C", courseCode: "HIST 2369", htmlUrl: "" },
  ] as Course[];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const user = { courses: [{ course: { id: 11, code: "ECE 3030", name: "A" } }, { course: { id: 12, code: "CS 3700", name: "B" } }, { course: { id: 13, code: "HIST 2369", name: "C" } }] };

  it("a failing course is named once and the others still contribute", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/api/user")) return json(user);
      if (url.includes("/courses/11/")) return json({ threads: [{ id: 1, type: "announcement", title: "Prelim 1", document: "<p>Prelim 1 is on Oct 13, 7:30 PM</p>" }] });
      return json({}, 500);
    });
    const result = await fetchEdTasks(courses, 240, NOW);
    expect(result.missed).toEqual(["CS 3700", "HIST 2369"]);
    expect(result.tasks).toHaveLength(1);
  });

  it("a sign-in problem stops at once as a single error", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return url.includes("/api/user") ? json(user) : json({}, 401);
    });
    await expect(fetchEdTasks(courses, 240, NOW)).rejects.toThrow(/not signed in/i);
    expect(calls).toHaveLength(2);
  });
});
