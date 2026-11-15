import { getOne } from "@/src/canvas/client";
import { AccessDeniedError } from "@/src/canvas/errors";
import type { TaskRead } from "@/src/lib/source-read";
import type { Course, Task } from "@/src/types/canvas";
import { tasksFromText } from "./tasks";

/**
 * Exam dates stated in each course's Canvas syllabus. One request per course;
 * an unreadable course reports incompleteness so its cached dates are retained.
 */
export async function fetchSyllabusTasks(courses: Course[], windowDays: number, now: Date = new Date(), overdueDays = 1): Promise<TaskRead> {
  const tasks: Task[] = [];
  const unavailableCourseIds: number[] = [];
  let firstError: unknown = null;
  for (const course of courses) {
    try {
      if (course.restricted) throw new AccessDeniedError("A restricted course syllabus could not be read.");
      const raw = await getOne<Record<string, unknown>>(`/courses/${course.id}`, { "include[]": ["syllabus_body"] });
      if (!Object.hasOwn(raw, "syllabus_body") || (raw["syllabus_body"] !== null && typeof raw["syllabus_body"] !== "string")) {
        throw new Error("Canvas did not return a readable syllabus field.");
      }
      const body = typeof raw["syllabus_body"] === "string" ? raw["syllabus_body"] : "";
      if (body) tasks.push(...tasksFromText(body, course, "syllabus", `${course.htmlUrl}/assignments/syllabus`, now, windowDays, overdueDays));
    } catch (error) {
      unavailableCourseIds.push(course.id);
      firstError ??= error;
    }
  }
  return { tasks, complete: unavailableCourseIds.length === 0, unavailableCourseIds, error: firstError };
}
