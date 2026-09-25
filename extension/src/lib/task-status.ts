/**
 * Derived task status.
 *
 * Computed on read, never stored, because the answer depends on the current
 * time: an unsubmitted task only becomes overdue once its due date passes.
 * Storing it would mean a cached snapshot slowly telling lies.
 */

import type { Task, TaskStatus } from "@/src/types/canvas";

/** Within this window of the due date, a task counts as "due soon". */
export const DUE_SOON_MS = 48 * 60 * 60 * 1000;

/**
 * Resolve a task's display status.
 *
 * Order matters. Work you have already handed in should never be reported as
 * overdue just because the deadline has passed, so submission state is checked
 * before the clock.
 */
export function taskStatus(task: Task, now: Date = new Date()): TaskStatus {
  const submission = task.submission;

  if (submission) {
    if (submission.excused) return "graded";
    if (submission.workflowState === "graded") return "graded";
    if (
      submission.workflowState === "submitted" ||
      submission.workflowState === "pending_review" ||
      submission.submittedAt !== null
    ) {
      return "submitted";
    }
    // Canvas's own `missing` flag is authoritative: an instructor can mark
    // something missing before its due date, or waive it after.
    if (submission.missing) return "missing";
  }

  if (!task.dueAt) return "no-due-date";

  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return "no-due-date";

  const elapsed = due - now.getTime();
  if (elapsed < 0) return "overdue";
  if (task.lockedForUser) return "locked";
  if (elapsed <= DUE_SOON_MS) return "due-soon";
  return "upcoming";
}

/** Sort key: earliest due date first, undated last. */
export function byDueDate(a: Task, b: Task): number {
  const timeA = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const timeB = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (timeA !== timeB) return timeA - timeB;
  return a.title.localeCompare(b.title);
}
