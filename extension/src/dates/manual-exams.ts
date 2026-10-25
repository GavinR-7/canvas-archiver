/**
 * Exam dates the person types in themselves.
 *
 * Some schedules cannot be read by the extension: the registrar's exam list sits
 * behind a NetID sign-in, Piazza forbids scraping and CMSX has no API. So each
 * current-term course gets a small "Exam dates" list. An entry is a date, an
 * optional time and a label. It becomes an exam task with source "manual",
 * shown as "Entered by you" and never marked unconfirmed, because the person is
 * the source. Pure apart from the storage helpers at the bottom.
 */

import { easternDay } from "./merge";
import { zonedToUtc } from "./extract";
import type { Course, Task } from "@/src/types/canvas";

export interface ManualExam {
  /** YYYY-MM-DD, a real calendar day. */
  date: string;
  /** HH:MM, 24 hour, Eastern; empty or absent means an all-day entry. */
  time?: string;
  label: string;
}

/** Course id (as a string key) to its entries. */
export type ManualExams = Record<string, ManualExam[]>;

export const MANUAL_EXAMS_KEY = "settings.manual-exams.v1";
export const MAX_ENTRIES = 20;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type EntryResult = { ok: true; entry: ManualExam } | { ok: false; error: string };

/** Check one entry as typed. A date that does not exist (2026-02-30) is rejected, not rolled over. */
export function validateEntry(input: { date: string; time?: string; label: string }): EntryResult {
  const date = input.date.trim();
  const time = (input.time ?? "").trim();
  const label = input.label.trim().replace(/\s+/g, " ");
  const m = DATE.exec(date);
  if (!m) return { ok: false, error: "Enter the date as YYYY-MM-DD." };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return { ok: false, error: "That date does not exist." };
  }
  if (time && !TIME.test(time)) return { ok: false, error: "Enter the time as HH:MM, 24 hour." };
  if (!label) return { ok: false, error: "Add a label such as Prelim 2 or Final." };
  if (label.length > 80) return { ok: false, error: "Keep the label under 80 characters." };
  return { ok: true, entry: time ? { date, time, label } : { date, label } };
}

const order = (a: ManualExam, b: ManualExam) =>
  a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.label.localeCompare(b.label);

/** Add an entry to a list: validated, a repeat of the same date, time and label ignored, kept in date order. */
export function addEntry(list: ManualExam[], input: { date: string; time?: string; label: string }): { list: ManualExam[]; error: string | null } {
  const result = validateEntry(input);
  if (!result.ok) return { list, error: result.error };
  const e = result.entry;
  if (list.some((x) => x.date === e.date && (x.time ?? "") === (e.time ?? "") && x.label.toLowerCase() === e.label.toLowerCase())) {
    return { list, error: null };
  }
  if (list.length >= MAX_ENTRIES) return { list, error: `At most ${MAX_ENTRIES} entries per course.` };
  return { list: [...list, e].sort(order), error: null };
}

export function removeEntry(list: ManualExam[], index: number): ManualExam[] {
  return list.filter((_, i) => i !== index);
}

/** Read stored data defensively: drop anything that no longer validates. */
export function cleanStored(raw: unknown): ManualExams {
  const out: ManualExams = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const entries: ManualExam[] = [];
    for (const item of value.slice(0, MAX_ENTRIES)) {
      const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const v = validateEntry({ date: String(r.date ?? ""), time: typeof r.time === "string" ? r.time : "", label: String(r.label ?? "") });
      if (v.ok) entries.push(v.entry);
    }
    if (entries.length) out[id] = entries.sort(order);
  }
  return out;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Exam tasks for the courses given. Entries for other courses (dropped, old term) are ignored. */
export function manualExamTasks(entries: ManualExams, courses: Course[]): Task[] {
  const tasks: Task[] = [];
  for (const course of courses) {
    for (const e of entries[String(course.id)] ?? []) {
      const [y, mo, d] = e.date.split("-").map(Number) as [number, number, number];
      const [h, mi] = e.time ? (e.time.split(":").map(Number) as [number, number]) : [23, 59];
      const dueAt = zonedToUtc(y, mo, d, h, mi).toISOString();
      tasks.push({
        id: `manual:${course.id}:${e.date}:${slug(e.label)}`,
        source: "manual",
        canvasId: course.id,
        kind: "exam",
        title: e.label,
        htmlUrl: course.htmlUrl,
        courseId: course.id,
        courseName: course.name,
        courseCode: course.courseCode,
        dueAt,
        unlockAt: null,
        lockAt: null,
        allDay: !e.time,
        pointsPossible: null,
        submissionTypes: [],
        lockedForUser: false,
        submission: null,
        unconfirmed: false,
      });
    }
  }
  return tasks;
}

/** Replace the manual tasks in a list of exams with fresh ones. Manual entries win over parsed twins. */
export function withManualExams(exams: Task[], entries: ManualExams, courses: Course[]): Task[] {
  return [...exams.filter((t) => t.source !== "manual"), ...manualExamTasks(entries, courses)];
}

export async function loadManualExams(): Promise<ManualExams> {
  try {
    const stored = await chrome.storage.local.get(MANUAL_EXAMS_KEY);
    return cleanStored(stored[MANUAL_EXAMS_KEY]);
  } catch {
    return {};
  }
}

export async function saveManualExams(entries: ManualExams): Promise<void> {
  await chrome.storage.local.set({ [MANUAL_EXAMS_KEY]: cleanStored(entries) });
}

/** Day shown for an entry, so the UI and tests agree on the Eastern calendar day. */
export const entryDay = (task: Task) => (task.dueAt ? easternDay(task.dueAt) : "");
