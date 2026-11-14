/**
 * What the popup lists under "Next 7 days".
 *
 * The popup is destroyed when it closes, so this is derived on each open from
 * the snapshot the service worker already holds. It does not fetch, and it
 * does not invent a second task list: it is a window and a cap over `Task`s.
 *
 * The window is seven local calendar days starting today, plus anything
 * already overdue or marked missing. A 14-day Upcoming page still exists for
 * the rest. Undated missing items sort first so a cap cannot hide them behind
 * later deadlines.
 */

import type { Task } from "@/src/types/canvas";
import { taskStatus, byDueDate } from "@/src/lib/task-status";
import { calendarDayOffset } from "@/src/lib/time";

/** Today plus the six days after it. */
export const POPUP_HORIZON_DAYS = 7;

/** How many rows fit in the popup before the rest are left to Upcoming. */
export const POPUP_ITEM_LIMIT = 4;

export interface PopupAgenda {
  items: Task[];
  /** Rows inside the window that `items` did not have room for. */
  hidden: number;
}

function inPopupWindow(task: Task, now: Date): boolean {
  if (taskStatus(task, now) === "missing") return true;
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return calendarDayOffset(task.dueAt, now) <= POPUP_HORIZON_DAYS - 1;
}

function comparePopupItems(a: Task, b: Task, now: Date): number {
  const aMissingUndated = taskStatus(a, now) === "missing" && a.dueAt === null;
  const bMissingUndated = taskStatus(b, now) === "missing" && b.dueAt === null;
  if (aMissingUndated !== bMissingUndated) return aMissingUndated ? -1 : 1;
  return byDueDate(a, b);
}

export function popupAgenda(
  tasks: readonly Task[],
  now: Date,
  limit: number = POPUP_ITEM_LIMIT,
): PopupAgenda {
  const cap = Math.max(0, limit);
  const sorted = tasks
    .filter((task) => inPopupWindow(task, now))
    .sort((a, b) => comparePopupItems(a, b, now));
  return {
    items: sorted.slice(0, cap),
    hidden: Math.max(0, sorted.length - cap),
  };
}
