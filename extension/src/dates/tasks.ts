/** Turning extracted date candidates into `Task`s the rest of the extension already understands. */

import { taskWindow, inTaskWindow } from "@/src/lib/task-window";
import type { Course, Task, TaskSource } from "@/src/types/canvas";
import { extractExamDates, type DateCandidate } from "./extract";

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export function candidateToTask(
  candidate: DateCandidate,
  course: Pick<Course, "id" | "name" | "courseCode" | "htmlUrl">,
  source: Extract<TaskSource, "syllabus" | "ed">,
  url: string | null,
): Task {
  return {
    id: `${source}:${course.id}:${candidate.at.slice(0, 10)}:${slug(candidate.title)}`,
    source,
    canvasId: course.id,
    kind: candidate.kind,
    title: candidate.title,
    htmlUrl: url ?? course.htmlUrl,
    courseId: course.id,
    courseName: course.name,
    courseCode: course.courseCode,
    dueAt: candidate.at,
    unlockAt: null,
    lockAt: null,
    allDay: candidate.allDay,
    pointsPossible: null,
    submissionTypes: [],
    lockedForUser: false,
    submission: null,
    unconfirmed: true,
    evidence: candidate.evidence,
  };
}

/** Exam and quiz dates stated in a block of course text, from `now` on (a day of grace). */
export function tasksFromText(
  html: string,
  course: Pick<Course, "id" | "name" | "courseCode" | "htmlUrl">,
  source: Extract<TaskSource, "syllabus" | "ed">,
  url: string | null,
  now: Date,
  windowDays: number,
  overdueDays = 1,
): Task[] {
  const window = taskWindow(now, windowDays, overdueDays);
  return extractExamDates(html, now)
    .filter((c) => inTaskWindow(c.at, window))
    .map((c) => candidateToTask(c, course, source, url));
}
