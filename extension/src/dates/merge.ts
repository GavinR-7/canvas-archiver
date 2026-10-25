/**
 * One list from four sources, without the same exam three times.
 *
 * A prelim can be in the syllabus, in an Ed announcement and in Gradescope.
 * Two tasks are the same when they are in the same course, on the same local
 * day, and their titles overlap (or both are exams). The more trustworthy
 * source wins: Canvas, then Gradescope, then Ed, then the syllabus.
 */

import { TIME_ZONE } from "./extract";
import type { Task } from "@/src/types/canvas";
import { byDueDate } from "@/src/lib/task-status";

const PRIORITY: Record<Task["source"], number> = { manual: -1, canvas: 0, gradescope: 1, ed: 2, syllabus: 3 };
const STOP = new Set(["the", "a", "an", "of", "and", "for", "in", "on", "at", "to", "exam", "due", "pm", "am"]);

export const courseKey = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
/** Local calendar day in Ithaca. An 11:59 PM deadline stays on its own day whatever the machine's zone. */
export const easternDay = (iso: string) => dayFmt.format(new Date(iso));

const EXAM_WORD = /prelim|midterm|mid-term|final|exam/i;

function tokens(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)));
}

export function sameDeadline(a: Task, b: Task): boolean {
  if (!a.dueAt || !b.dueAt) return false;
  // A date the person typed belongs to one Canvas course: two courses can share a catalog code, so only the id matches.
  if (a.source === "manual" || b.source === "manual") {
    if (a.courseId !== b.courseId) return false;
  } else if (courseKey(a.courseCode) !== courseKey(b.courseCode) || !courseKey(a.courseCode)) return false;
  if (easternDay(a.dueAt) !== easternDay(b.dueAt)) return false;
  if (EXAM_WORD.test(a.title) && EXAM_WORD.test(b.title)) return true;
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared > 0 && shared / Math.min(ta.size, tb.size) >= 0.5;
}

export function mergeTasks(tasks: Task[]): Task[] {
  const ordered = [...tasks].sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source]);
  const kept: Task[] = [];
  for (const task of ordered) {
    const twin = kept.find((k) => k.id !== task.id && sameDeadline(k, task));
    if (!twin) kept.push(task);
  }
  return kept.sort(byDueDate);
}
