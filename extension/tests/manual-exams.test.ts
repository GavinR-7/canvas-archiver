import { describe, expect, it } from "vitest";
import { addEntry, cleanStored, manualExamTasks, removeEntry, validateEntry, withManualExams } from "@/src/dates/manual-exams";
import { examsByCourse } from "@/src/dates/exams";
import { buildDueFile } from "@/src/sync/due";
import { mergeTasks } from "@/src/dates/merge";
import { candidateToTask } from "@/src/dates/tasks";
import type { Course } from "@/src/types/canvas";

const course = { id: 7, name: "Signals", courseCode: "ECE 3250", htmlUrl: "https://canvas/courses/7", restricted: false, term: { code: "FA26", name: "Fall 2026", startAt: "2026-08-01T00:00:00Z", endAt: "2026-12-31T00:00:00Z" } } as unknown as Course;
const now = new Date("2026-10-25T12:00:00Z");

describe("validateEntry", () => {
  it("accepts a date with and without a time", () => {
    expect(validateEntry({ date: "2026-11-05", time: "19:30", label: " Prelim  2 " })).toEqual({ ok: true, entry: { date: "2026-11-05", time: "19:30", label: "Prelim 2" } });
    expect(validateEntry({ date: "2026-12-12", label: "Final" })).toEqual({ ok: true, entry: { date: "2026-12-12", label: "Final" } });
  });
  it("rejects invalid dates, times and labels", () => {
    for (const date of ["2026-02-30", "2026-13-01", "11/05/2026", "", "2026-11-5"]) expect(validateEntry({ date, label: "Final" }).ok).toBe(false);
    expect(validateEntry({ date: "2026-11-05", time: "25:00", label: "Final" }).ok).toBe(false);
    expect(validateEntry({ date: "2026-11-05", label: "  " }).ok).toBe(false);
  });
});

describe("addEntry", () => {
  it("keeps entries in date order and ignores repeats", () => {
    let list = addEntry([], { date: "2026-12-12", label: "Final" }).list;
    list = addEntry(list, { date: "2026-11-05", time: "19:30", label: "Prelim 2" }).list;
    list = addEntry(list, { date: "2026-10-01", label: "Prelim 1" }).list;
    list = addEntry(list, { date: "2026-10-01", label: "prelim 1" }).list;
    expect(list.map((e) => e.label)).toEqual(["Prelim 1", "Prelim 2", "Final"]);
    expect(removeEntry(list, 1).map((e) => e.label)).toEqual(["Prelim 1", "Final"]);
  });
  it("leaves the list alone and reports the error for a bad date", () => {
    const r = addEntry([{ date: "2026-12-12", label: "Final" }], { date: "2026-02-30", label: "X" });
    expect(r.error).toMatch(/does not exist/);
    expect(r.list).toHaveLength(1);
  });
});

describe("cleanStored", () => {
  it("drops entries that no longer validate", () => {
    expect(cleanStored({ "7": [{ date: "nope", label: "x" }, { date: "2026-11-05", label: "Prelim" }], "8": "bad" })).toEqual({ "7": [{ date: "2026-11-05", label: "Prelim" }] });
  });
});

describe("manualExamTasks", () => {
  it("makes confirmed exam tasks sourced 'manual' at the Eastern time, all-day when no time", () => {
    const [timed, allDay] = manualExamTasks({ "7": [{ date: "2026-11-05", time: "19:30", label: "Prelim 2" }, { date: "2026-12-12", label: "Final" }], "99": [{ date: "2026-11-06", label: "Other" }] }, [course]);
    expect(timed).toMatchObject({ source: "manual", kind: "exam", title: "Prelim 2", unconfirmed: false, allDay: false, dueAt: "2026-11-06T00:30:00.000Z" });
    expect(allDay).toMatchObject({ allDay: true, courseId: 7 });
    expect(manualExamTasks({ "99": [{ date: "2026-11-06", label: "Other" }] }, [course])).toHaveLength(0);
  });
});

describe("merge with parsed exams", () => {
  const parsed = candidateToTask({ title: "Prelim 2", kind: "exam", at: "2026-11-06T00:30:00.000Z", allDay: false, evidence: "Prelim 2 Nov 5" } as never, course, "syllabus", null);
  it("the entered exam replaces a parsed twin on the same day and appears in All exams", () => {
    const exams = mergeTasks(withManualExams([parsed], { "7": [{ date: "2026-11-05", time: "19:30", label: "Prelim 2" }] }, [course]));
    expect(exams).toHaveLength(1);
    expect(exams[0]).toMatchObject({ source: "manual", unconfirmed: false });
    expect(examsByCourse(exams, [course], now)[0]?.exams.map((t) => t.title)).toEqual(["Prelim 2"]);
  });
  it("keeps parsed exams on other days and refreshes old manual tasks", () => {
    const stale = manualExamTasks({ "7": [{ date: "2026-11-20", label: "Old" }] }, [course]);
    const exams = mergeTasks(withManualExams([parsed, ...stale], { "7": [{ date: "2026-12-12", label: "Final" }] }, [course]));
    expect(exams.map((t) => t.title)).toEqual(["Prelim 2", "Final"]);
  });
  it("is exported to due.json as manual and not unconfirmed", () => {
    const tasks = manualExamTasks({ "7": [{ date: "2026-11-05", time: "19:30", label: "Prelim 2" }] }, [course]);
    expect(buildDueFile(tasks, now).items[0]).toMatchObject({ source: "manual", kind: "exam", unconfirmed: false, dueDay: "2026-11-05" });
  });
});

describe("review fixes (T-531)", () => {
  const sibling = { ...course, id: 8, name: "Signals (section 2)", htmlUrl: "https://canvas/courses/8" } as Course;
  it("an entry for one course never replaces a parsed twin in another course that shares the catalog code", () => {
    const parsedOther = candidateToTask({ title: "Prelim 2", kind: "exam", at: "2026-11-06T00:30:00.000Z", allDay: false, evidence: "Prelim 2 Nov 5" } as never, sibling, "syllabus", null);
    const exams = mergeTasks(withManualExams([parsedOther], { "7": [{ date: "2026-11-05", time: "19:30", label: "Prelim 2" }] }, [course, sibling]));
    expect(exams.map((t) => [t.source, t.courseId])).toEqual([["manual", 7], ["syllabus", 8]]);
  });
  it("still replaces a parsed twin in the same course", () => {
    const parsed = candidateToTask({ title: "Prelim 2", kind: "exam", at: "2026-11-06T00:30:00.000Z", allDay: false, evidence: "x" } as never, course, "syllabus", null);
    expect(mergeTasks(withManualExams([parsed], { "7": [{ date: "2026-11-05", time: "19:30", label: "Prelim 2" }] }, [course])).map((t) => t.source)).toEqual(["manual"]);
  });
  it("rejects a time the spring-forward night skips", () => {
    const r = validateEntry({ date: "2026-03-08", time: "02:30", label: "Quiz" });
    expect(r.ok).toBe(false);
    expect(validateEntry({ date: "2026-03-08", time: "03:30", label: "Quiz" }).ok).toBe(true);
    expect(manualExamTasks({ "7": [{ date: "2026-03-08", time: "02:30", label: "Quiz" }] }, [course])).toHaveLength(0);
  });
  it("resolves a time that happens twice to the first one and says so", () => {
    const r = validateEntry({ date: "2026-11-01", time: "01:30", label: "Quiz" });
    expect(r).toMatchObject({ ok: true, notice: expect.stringMatching(/twice.*first.*UTC-4/) });
    expect(manualExamTasks({ "7": [{ date: "2026-11-01", time: "01:30", label: "Quiz" }] }, [course])[0]?.dueAt).toBe("2026-11-01T05:30:00.000Z");
    expect(addEntry([], { date: "2026-11-01", time: "01:30", label: "Quiz" }).notice).toMatch(/twice/);
    expect(validateEntry({ date: "2026-11-01", time: "03:30", label: "Quiz" })).not.toHaveProperty("notice");
  });
});
