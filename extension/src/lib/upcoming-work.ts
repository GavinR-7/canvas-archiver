import { isExamTask } from "@/src/dates/exams";
import { taskStatus } from "@/src/lib/task-status";
import { inTaskWindow, taskWindow } from "@/src/lib/task-window";
import type { Task } from "@/src/types/canvas";

function dueTime(task: Task): number {
  const time = task.dueAt ? Date.parse(task.dueAt) : NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function byKnownDueTime(a: Task, b: Task): number {
  return dueTime(a) - dueTime(b) || a.title.localeCompare(b.title);
}

/** Only Gradescope has its own numeric course IDs in the snapshot. */
export function workCourseKey(source: Task["source"], courseId: number): string {
  return `${source === "gradescope" ? "gradescope" : "canvas"}:${courseId}`;
}

export function upcomingWork(
  tasks: readonly Task[],
  now: Date,
  days: number,
  courseKey: string | null,
  showCompleted: boolean,
): { attention: Task[]; upcoming: Task[] } {
  const window = taskWindow(now, days);
  const attention: Task[] = [];
  const upcoming: Task[] = [];

  for (const task of tasks) {
    if (courseKey !== null && workCourseKey(task.source, task.courseId) !== courseKey) continue;

    const status = taskStatus(task, now);
    if (status === "missing" || (status === "overdue" && !isExamTask(task))) {
      attention.push(task);
      continue;
    }

    if (!showCompleted && (status === "submitted" || status === "graded")) continue;
    if (inTaskWindow(task.dueAt, window)) upcoming.push(task);
  }

  return { attention: attention.sort(byKnownDueTime), upcoming: upcoming.sort(byKnownDueTime) };
}
