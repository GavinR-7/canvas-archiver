import { describe, expect, it } from "vitest";
import { extractExamDates, toLines, zonedToUtc } from "@/src/dates/extract";
import { mergeTasks, sameDeadline } from "@/src/dates/merge";
import { tasksFromText } from "@/src/dates/tasks";
import type { Task } from "@/src/types/canvas";

const now = new Date("2026-10-01T12:00:00Z");
const course = { id: 7, name: "Networks", courseCode: "CS 3700", htmlUrl: "https://canvas.cornell.edu/courses/7" };

describe("zonedToUtc", () => {
  it("applies EDT in October and EST in December", () => {
    expect(zonedToUtc(2026, 10, 14, 19, 30).toISOString()).toBe("2026-10-14T23:30:00.000Z");
    expect(zonedToUtc(2026, 12, 10, 19, 30).toISOString()).toBe("2026-12-11T00:30:00.000Z");
  });
  it("is right across the November fall-back", () => {
    expect(zonedToUtc(2026, 11, 1, 0, 30).toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(zonedToUtc(2026, 11, 1, 12, 0).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
});

describe("extractExamDates", () => {
  it("reads a prelim with a date and time", () => {
    const [c] = extractExamDates("<p>Prelim 1: Wednesday, October 14, 7:30 PM, Olin 155</p>", now);
    expect(c).toMatchObject({ kind: "exam", at: "2026-10-14T23:30:00.000Z", allDay: false });
    expect(c?.title).toMatch(/^Prelim 1/);
  });
  it("reads table rows, numeric dates, and noon", () => {
    const html = "<table><tr><td>Midterm</td><td>10/22</td><td>noon</td></tr><tr><td>Final Exam</td><td>Dec 15, 2026</td><td>2:00pm</td></tr></table>";
    const out = extractExamDates(html, now);
    expect(out.map((c) => [c.kind, c.at, c.allDay])).toEqual([
      ["exam", "2026-10-22T16:00:00.000Z", false],
      ["exam", "2026-12-15T19:00:00.000Z", false],
    ]);
  });
  it("treats a date with no time as all-day, end of the day Eastern", () => {
    const [c] = extractExamDates("Quiz 2 on Nov 3", now);
    expect(c).toMatchObject({ kind: "quiz", allDay: true, at: "2026-11-04T04:59:00.000Z" });
  });
  it("puts a year-less January date in the next year when read in December", () => {
    const [c] = extractExamDates("Prelim 2: Jan 28 7pm", new Date("2026-12-10T00:00:00Z"));
    expect(c?.at.startsWith("2027-01-29") || c?.at.startsWith("2027-01-28")).toBe(true);
  });
  it("ignores policy sentences, impossible dates and lines with no keyword", () => {
    const html = "<p>Exams are closed-book.</p><p>Prelim on Feb 31</p><p>Homework 3 due Oct 9</p><p>Office hours 3pm</p>";
    expect(extractExamDates(html, now)).toEqual([]);
  });
  it("lists a repeated exam once", () => {
    expect(extractExamDates("Prelim 1 Oct 14 7pm\nPrelim 1 (Oct 14, 7pm)", now)).toHaveLength(1);
  });
  it("does not execute or keep script content", () => {
    expect(toLines("<script>Prelim Oct 1</script><p>hi</p>")).toEqual(["hi"]);
  });
});

describe("tasksFromText", () => {
  it("makes unconfirmed tasks inside the window only", () => {
    const html = "Prelim 1 Oct 14 7:30pm\nPrelim 0 Sep 3 7:30pm\nFinal Exam Dec 15 2pm";
    const tasks = tasksFromText(html, course, "syllabus", null, now, 30);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ source: "syllabus", kind: "exam", unconfirmed: true, courseCode: "CS 3700", htmlUrl: course.htmlUrl });
    expect(tasks[0]?.id).toMatch(/^syllabus:7:2026-10-14:/);
  });
});

const task = (over: Partial<Task>): Task => ({
  id: "x", source: "canvas", canvasId: 1, kind: "assignment", title: "t", htmlUrl: "u", courseId: 7, courseName: "Networks",
  courseCode: "CS 3700", dueAt: "2026-10-14T23:30:00Z", unlockAt: null, lockAt: null, allDay: false, pointsPossible: null,
  submissionTypes: [], lockedForUser: false, submission: null, ...over,
});

describe("mergeTasks", () => {
  it("keeps one prelim from three sources, preferring the most trusted", () => {
    const merged = mergeTasks([
      task({ id: "syllabus:1", source: "syllabus", kind: "exam", title: "Prelim 1", unconfirmed: true }),
      task({ id: "ed:1", source: "ed", kind: "exam", title: "Prelim 1 logistics", unconfirmed: true }),
      task({ id: "gradescope:1", source: "gradescope", title: "Prelim 1" }),
    ]);
    expect(merged.map((t) => t.id)).toEqual(["gradescope:1"]);
  });
  it("keeps different deadlines the same day, and the same title on different days", () => {
    const a = task({ id: "a", title: "Lab 3 report" });
    expect(mergeTasks([a, task({ id: "b", title: "Prelim 1", kind: "exam", source: "syllabus" })])).toHaveLength(2);
    expect(sameDeadline(a, task({ id: "c", title: "Lab 3 report", dueAt: "2026-10-21T23:30:00Z" }))).toBe(false);
  });
  it("does not merge across courses", () => {
    expect(sameDeadline(task({ title: "Prelim 1" }), task({ id: "q", title: "Prelim 1", courseCode: "ECE 3140" }))).toBe(false);
  });
  it("uses the Eastern calendar day, not UTC", () => {
    // 11:59 PM EDT Oct 14 is already Oct 15 in UTC.
    expect(sameDeadline(task({ title: "Prelim 1", dueAt: "2026-10-15T03:59:00Z" }), task({ id: "q", title: "Prelim 1", dueAt: "2026-10-14T23:30:00Z" }))).toBe(true);
  });
});

import { matchCourse, normalizeEdCourses, normalizeEdThreads, worthReading } from "@/src/ed/api";

describe("ed normalisers", () => {
  it("reads courses, skipping archived ones and entries without an id", () => {
    expect(
      normalizeEdCourses({ courses: [{ course: { id: 1, code: "CS 3700", name: "Networks" } }, { course: { id: 2, code: "X", status: "archived" } }, { course: {} }] }),
    ).toEqual([{ id: 1, code: "CS 3700", name: "Networks" }]);
    expect(normalizeEdCourses({})).toEqual([]);
  });
  it("reads threads and keeps only announcements and pinned ones", () => {
    const threads = normalizeEdThreads({
      threads: [
        { id: 1, number: 12, title: "Prelim 1 logistics", type: "announcement", document: "<p>Oct 14 7:30 PM</p>" },
        { id: 2, title: "Question", type: "question" },
        { id: 3, title: "Pinned", type: "post", is_pinned: true },
        { title: "no id" },
      ],
    });
    expect(threads.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(threads.filter(worthReading).map((t) => t.id)).toEqual([1, 3]);
    expect(threads[0]?.text).toContain("Oct 14");
  });
  it("matches an Ed course to a Canvas one by code, ignoring spacing", () => {
    const canvas = [{ ...course, courseCode: "CS 3700" }, { ...course, id: 9, courseCode: "ECE 3140" }] as never[];
    expect(matchCourse({ id: 1, code: "CS3700", name: "" }, canvas)?.id).toBe(7);
    expect(matchCourse({ id: 1, code: "", name: "ECE 3140 Embedded" }, canvas)?.id).toBe(9);
    expect(matchCourse({ id: 1, code: "MATH 1920", name: "" }, canvas)).toBeNull();
  });
});
