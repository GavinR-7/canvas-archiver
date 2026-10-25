/**
 * The "All exams" list: every known exam date for the courses the person is
 * taking now, however far away. The 14-day Upcoming list hides an exam until
 * it is two weeks out; this is the one place to see them all.
 *
 * Exams come from the same sources as every other task (planner, Gradescope,
 * syllabus, Ed), so nothing here invents a date. A course with none is listed
 * as having none.
 */

import { splitCourses } from "@/src/canvas/visibility";
import { byDueDate } from "@/src/lib/task-status";
import type { Course, Task } from "@/src/types/canvas";
import { mergeTasks } from "./merge";

/** How far ahead exam dates are collected: a full term and a bit more. */
export const EXAM_DAYS = 240;

const EXAM_TITLE = /\b(prelim(?:inary)?|mid-?term|final\s+exam|exam)s?\b/i;
// "Exam review session", "Exam policy": about an exam, not the exam.
const NOT_THE_EXAM = /\b(review|policy|policies|regrade|solutions?|prep|logistics)\b/i;

export function isExamTask(task: Task): boolean {
  if (!task.dueAt) return false;
  if (task.kind === "exam") return true;
  return EXAM_TITLE.test(task.title) && !NOT_THE_EXAM.test(task.title);
}

const DAY_MS = 86_400_000;

/**
 * A task is inside the Upcoming window when it falls between now (a day of grace
 * for text-derived dates, as they always had) and `days` ahead.
 */
export function inWindow(task: Task, now: Date, days: number): boolean {
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt).getTime();
  const grace = task.source === "syllabus" || task.source === "ed" ? DAY_MS : 0;
  return due >= now.getTime() - grace && due <= now.getTime() + days * DAY_MS;
}

export interface CourseExams {
  course: Course;
  exams: Task[];
}

/** Exams from today on, per current-term course, sorted by date. Courses with none still appear. */
export function examsByCourse(exams: Task[], courses: Course[], now: Date): CourseExams[] {
  const upcoming = mergeTasks(exams.filter((t) => isExamTask(t) && new Date(t.dueAt as string).getTime() >= now.getTime() - DAY_MS));
  return splitCourses(courses.filter((c) => !c.restricted), now).shown.map((course) => ({
    course,
    exams: upcoming.filter((t) => t.courseId === course.id).sort(byDueDate),
  }));
}
