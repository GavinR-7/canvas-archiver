import { describe, expect, it } from "vitest";
import type { Course, Task } from "@/src/types/canvas";
import { resolveTerm } from "@/src/canvas/terms";
import { examsByCourse, inWindow, isExamTask } from "@/src/dates/exams";

const NOW = new Date("2026-10-25T17:00:00Z");
const FA26 = { id: 1, name: "Fall 2026", start_at: "2026-08-24T04:00:00Z", end_at: "2026-12-22T05:00:00Z" };
const SU18 = { id: 2, name: "Summer 2018", start_at: "2018-06-01T00:00:00Z", end_at: "2018-08-20T00:00:00Z" };

const course = (id: number, code: string, term: Parameters<typeof resolveTerm>[0]): Course =>
  ({ id, name: code, courseCode: code, term: resolveTerm(term), restricted: false }) as Course;

const task = (id: string, courseId: number, title: string, daysAhead: number, over: Partial<Task> = {}): Task =>
  ({
    id,
    source: "canvas",
    canvasId: 1,
    kind: "assignment",
    title,
    htmlUrl: "",
    courseId,
    courseName: "",
    courseCode: `C${courseId}`,
    dueAt: new Date(NOW.getTime() + daysAhead * 86_400_000).toISOString(),
    unlockAt: null,
    lockAt: null,
    allDay: false,
    pointsPossible: null,
    submissionTypes: [],
    lockedForUser: false,
    submission: null,
    ...over,
  }) as Task;

describe("exam classification", () => {
  it("takes exam-kind items and exam-worded titles, not homework or exam logistics", () => {
    expect(isExamTask(task("a", 1, "Prelim 2", 30))).toBe(true);
    expect(isExamTask(task("b", 1, "Midterm Exam", 30))).toBe(true);
    expect(isExamTask(task("c", 1, "Final Exam", 90))).toBe(true);
    expect(isExamTask(task("d", 1, "Whatever", 30, { kind: "exam" }))).toBe(true);
    expect(isExamTask(task("e", 1, "HW7", 3))).toBe(false);
    expect(isExamTask(task("f", 1, "Exam review session", 3))).toBe(false);
    expect(isExamTask(task("g", 1, "Final project proposal", 3))).toBe(false);
    expect(isExamTask(task("h", 1, "Prelim 3", 30, { dueAt: null }))).toBe(false);
  });
});

describe("window bypass", () => {
  it("the Upcoming window drops a far exam that All exams keeps", () => {
    const far = task("p", 1, "Prelim 2", 60);
    expect(inWindow(far, NOW, 14)).toBe(false);
    expect(inWindow(task("q", 1, "HW7", 5), NOW, 14)).toBe(true);
    const groups = examsByCourse([far], [course(1, "ECE 3140", FA26)], NOW);
    expect(groups[0]?.exams.map((t) => t.id)).toEqual(["p"]);
  });

  it("text-derived dates keep their day of grace, planner dates do not", () => {
    expect(inWindow(task("s", 1, "Prelim", -0.5, { source: "syllabus" }), NOW, 14)).toBe(true);
    expect(inWindow(task("t", 1, "Prelim", -0.5), NOW, 14)).toBe(false);
  });
});

describe("exams by course", () => {
  const courses = [course(1, "ECE 3140", FA26), course(2, "CS 3700", FA26), course(3, "ORIENT 0001", SU18)];

  it("lists current-term courses only, sorted by date, with 'none' for a course without exams", () => {
    const groups = examsByCourse(
      [task("late", 1, "Final Exam", 50), task("early", 1, "Prelim 1", 10), task("old", 3, "Prelim", 10)],
      courses,
      NOW,
    );
    expect(groups.map((g) => g.course.id)).toEqual([1, 2]);
    expect(groups[0]?.exams.map((t) => t.id)).toEqual(["early", "late"]);
    expect(groups[1]?.exams).toEqual([]);
  });

  it("drops exams already over and shows the same prelim once across sources", () => {
    const groups = examsByCourse(
      [
        task("past", 1, "Prelim 1", -10),
        task("gs", 1, "Prelim 2", 20, { source: "gradescope" }),
        task("syl", 1, "Prelim 2", 20, { source: "syllabus", unconfirmed: true }),
      ],
      courses,
      NOW,
    );
    expect(groups[0]?.exams.map((t) => t.id)).toEqual(["gs"]);
  });
});
