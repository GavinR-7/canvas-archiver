/**
 * The `due.json` contract.
 *
 * HQ's morning plan reads this file instead of asking Gavin what is due. It
 * carries only what a plan needs: course, title, kind, when, where to open it,
 * and whether it is done or only guessed. No submission scores, no grades,
 * no private notes.
 *
 * Idempotence matters because every sync is a git commit: `sameContent`
 * ignores `generatedAt`, so an unchanged schedule produces no commit.
 */

import { DEADLINE_LOOKAHEAD_DAYS, DEADLINE_OVERDUE_DAYS, taskWindow, inTaskWindow } from "@/src/lib/task-window";
import { easternDay } from "@/src/dates/merge";
import type { Task } from "@/src/types/canvas";

export const DUE_VERSION = 1;

export interface DueItem {
  id: string;
  source: Task["source"];
  course: string;
  title: string;
  kind: Task["kind"];
  /** ISO 8601 UTC. */
  dueAt: string;
  /** Eastern calendar day, so a reader never has to convert 11:59 PM. */
  dueDay: string;
  allDay: boolean;
  url: string;
  /** Already handed in or graded: list it as done, not as a deadline. */
  done: boolean;
  /** Read from prose (syllabus, Ed) and not confirmed by Canvas or Gradescope. */
  unconfirmed: boolean;
}

export interface DueFile {
  version: typeof DUE_VERSION;
  generatedAt: string;
  timezone: "America/New_York";
  items: DueItem[];
}

const isDone = (task: Task) => {
  const s = task.submission?.workflowState;
  return s === "submitted" || s === "graded" || task.submission?.excused === true;
};

export function buildDueFile(tasks: Task[], now: Date, windowDays = DEADLINE_LOOKAHEAD_DAYS): DueFile {
  const window = taskWindow(now, windowDays, DEADLINE_OVERDUE_DAYS);
  const items: DueItem[] = tasks
    .filter((t): t is Task & { dueAt: string } => {
      return t.dueAt !== null && inTaskWindow(t.dueAt, window);
    })
    .map((t) => ({
      id: t.id,
      source: t.source,
      course: t.courseCode || t.courseName,
      title: t.title,
      kind: t.kind,
      dueAt: new Date(t.dueAt).toISOString(),
      dueDay: easternDay(t.dueAt),
      allDay: t.allDay,
      url: t.htmlUrl,
      done: isDone(t),
      unconfirmed: t.unconfirmed === true,
    }))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  return { version: DUE_VERSION, generatedAt: now.toISOString(), timezone: "America/New_York", items };
}

export function serialize(file: DueFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Same schedule, ignoring when it was generated. Unparseable existing content counts as different. */
export function sameContent(existing: string, next: DueFile): boolean {
  try {
    const old = JSON.parse(existing) as Partial<DueFile>;
    return JSON.stringify(old.items) === JSON.stringify(next.items) && old.version === next.version && old.timezone === next.timezone;
  } catch {
    return false;
  }
}
