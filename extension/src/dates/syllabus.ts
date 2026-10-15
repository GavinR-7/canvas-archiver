import { getOne } from "@/src/canvas/client";
import { AccessDeniedError, NotFoundError } from "@/src/canvas/errors";
import type { Course, Task } from "@/src/types/canvas";
import { tasksFromText } from "./tasks";

/**
 * Exam dates stated in each course's Canvas syllabus. One request per course;
 * a course with no syllabus, or one the student cannot read, contributes nothing.
 */
export async function fetchSyllabusTasks(courses: Course[], windowDays: number, now: Date = new Date()): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const course of courses) {
    try {
      const raw = await getOne<Record<string, unknown>>(`/courses/${course.id}`, { "include[]": ["syllabus_body"] });
      const body = typeof raw["syllabus_body"] === "string" ? raw["syllabus_body"] : "";
      if (body) tasks.push(...tasksFromText(body, course, "syllabus", `${course.htmlUrl}/assignments/syllabus`, now, windowDays));
    } catch (error) {
      if (error instanceof AccessDeniedError || error instanceof NotFoundError) continue;
      throw error;
    }
  }
  return tasks;
}
