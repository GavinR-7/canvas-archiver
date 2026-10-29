/** Rolling UTC windows: identical bounds for source reads, exports and UI views. */
export const DEADLINE_LOOKAHEAD_DAYS = 60;
export const DEADLINE_OVERDUE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface TaskWindow { from: number; to: number }

export function taskWindow(now: Date, days: number, overdueDays = 0): TaskWindow {
  return { from: now.getTime() - overdueDays * DAY_MS, to: now.getTime() + days * DAY_MS };
}

export function inTaskWindow(dueAt: string | null, window: TaskWindow): boolean {
  if (!dueAt) return false;
  const at = new Date(dueAt).getTime();
  return at >= window.from && at <= window.to;
}

export function tasksInWindow<T extends { dueAt: string | null }>(tasks: T[], window: TaskWindow): T[] {
  return tasks.filter((task) => inTaskWindow(task.dueAt, window));
}
