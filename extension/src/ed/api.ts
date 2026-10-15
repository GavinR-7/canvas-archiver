/**
 * Ed Discussion: staff announcements and pinned threads, read for exam dates.
 *
 * UNVERIFIED against a real account. Written from how Ed's web client behaves
 * (JSON under /api, `GET /api/user` listing courses, `GET /api/courses/:id/threads`).
 * Two things only a live run can settle: the exact response fields (the
 * normalisers below tolerate absence) and whether a cookie alone authenticates
 * from the service worker. A 401 surfaces as "sign in to Ed" and never blanks
 * Canvas or Gradescope data.
 *
 * GET only, `credentials: "include"`, origin checked before the one `fetch`.
 */

import { CanvasError, SessionExpiredError } from "@/src/canvas/errors";
import { assertCanvasOrigin } from "@/src/canvas/url-guard";
import { ED_API_ORIGIN } from "@/src/config/ed";
import { courseKey } from "@/src/dates/merge";
import { tasksFromText } from "@/src/dates/tasks";
import type { Course, Task } from "@/src/types/canvas";

type Raw = Record<string, unknown>;

export class EdSessionExpiredError extends SessionExpiredError {
  constructor() {
    super("You're not signed in to Ed Discussion, or your session expired.");
    this.name = "EdSessionExpiredError";
  }
}

async function getJson(path: string): Promise<Raw> {
  const url = assertCanvasOrigin(`${ED_API_ORIGIN}${path}`, ED_API_ORIGIN);
  const response = await fetch(url, { method: "GET", credentials: "include", headers: { Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) throw new EdSessionExpiredError();
  if (!response.ok) throw new CanvasError(`Ed returned ${response.status} for ${path}.`);
  return (await response.json()) as Raw;
}

export interface EdCourse {
  id: number;
  code: string;
  name: string;
}

export interface EdThread {
  id: number;
  number: number | null;
  title: string;
  type: string;
  pinned: boolean;
  createdAt: string | null;
  /** Title plus body, as HTML or Ed's XML-ish markup; only ever read as text. */
  text: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeEdCourses(raw: Raw): EdCourse[] {
  const entries = Array.isArray(raw["courses"]) ? (raw["courses"] as Raw[]) : [];
  const out: EdCourse[] = [];
  for (const entry of entries) {
    const course = (entry["course"] ?? entry) as Raw;
    const id = num(course["id"]);
    if (id === null) continue;
    // Archived courses from earlier terms are listed too; skip them.
    if (str(course["status"]) === "archived") continue;
    out.push({ id, code: str(course["code"]) ?? "", name: str(course["name"]) ?? "" });
  }
  return out;
}

export function normalizeEdThreads(raw: Raw): EdThread[] {
  const entries = Array.isArray(raw["threads"]) ? (raw["threads"] as Raw[]) : [];
  const out: EdThread[] = [];
  for (const t of entries) {
    const id = num(t["id"]);
    if (id === null) continue;
    const title = str(t["title"]) ?? "";
    out.push({
      id,
      number: num(t["number"]),
      title,
      type: str(t["type"]) ?? "post",
      pinned: t["is_pinned"] === true || t["pinned"] === true,
      createdAt: str(t["created_at"]),
      text: `<p>${title}</p>${str(t["document"]) ?? str(t["content"]) ?? ""}`,
    });
  }
  return out;
}

/** Announcements and pinned threads only: general chatter is where false positives live. */
export function worthReading(thread: EdThread): boolean {
  return thread.type === "announcement" || thread.pinned;
}

/** Match an Ed course to a Canvas one by course code ("CS 3700" vs "CS3700"), falling back to a code inside the name. */
export function matchCourse(ed: EdCourse, courses: Course[]): Course | null {
  const key = courseKey(ed.code);
  if (key) {
    const byCode = courses.find((c) => courseKey(c.courseCode) === key);
    if (byCode) return byCode;
  }
  const haystack = courseKey(ed.name);
  return courses.find((c) => c.courseCode && haystack.includes(courseKey(c.courseCode))) ?? null;
}

export async function fetchEdTasks(courses: Course[], windowDays: number, now: Date = new Date()): Promise<Task[]> {
  const edCourses = normalizeEdCourses(await getJson("/api/user"));
  const tasks: Task[] = [];
  for (const ed of edCourses) {
    const course = matchCourse(ed, courses);
    if (!course) continue;
    const threads = normalizeEdThreads(await getJson(`/api/courses/${ed.id}/threads?limit=50&sort=new`));
    for (const thread of threads.filter(worthReading)) {
      const url = `https://edstem.org/us/courses/${ed.id}/discussion/${thread.number ?? thread.id}`;
      tasks.push(...tasksFromText(thread.text, course, "ed", url, now, windowDays));
    }
  }
  return tasks;
}
