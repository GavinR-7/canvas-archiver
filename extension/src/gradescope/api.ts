/**
 * Fetching Gradescope pages and turning them into tasks.
 *
 * Same posture as the Canvas client: GET only, `credentials: "include"` (the
 * service worker is cross-origin, so without it the session cookie is
 * silently dropped), and an origin check immediately before the one `fetch`.
 * Courses are fetched one at a time — a student has a handful, and Gradescope
 * documents no rate limit, so there is nothing to gain from bursting.
 */

import { SessionExpiredError, CanvasError } from "@/src/canvas/errors";
import { currentTermCode, termSortKey } from "@/src/canvas/terms";
import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import { byDueDate } from "@/src/lib/task-status";
import type { Task } from "@/src/types/canvas";
import { assertCanvasOrigin } from "@/src/canvas/url-guard";
import { listGradescopeFiles, type GradescopeListing } from "./files";
import { parseAssignments, parseCourses, type GradescopeCourse } from "./parse";

export class GradescopeSessionExpiredError extends SessionExpiredError {
  constructor() {
    super("You're not signed in to Gradescope, or your session expired.");
    this.name = "GradescopeSessionExpiredError";
  }
}

export async function getHtml(path: string): Promise<{ html: string; url: string }> {
  const url = assertCanvasOrigin(`${GRADESCOPE_ORIGIN}${path}`, GRADESCOPE_ORIGIN);

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/html" },
    redirect: "follow",
  });

  // Signed-out requests are redirected to /login (or /saml SSO hops).
  if (response.redirected && /\/(login|saml)\b/.test(new URL(response.url).pathname)) {
    throw new GradescopeSessionExpiredError();
  }
  if (response.status === 401) throw new GradescopeSessionExpiredError();
  if (!response.ok) {
    throw new CanvasError(`Gradescope returned ${response.status} for ${path}.`);
  }
  return { html: await response.text(), url: response.url };
}

/** The newest term on the account page, so last semester's courses are skipped. */
export function currentCourses(courses: GradescopeCourse[], now: Date): GradescopeCourse[] {
  const wanted = currentTermCode(now);
  const inCurrentTerm = courses.filter((c) => c.termCode === wanted);
  if (inCurrentTerm.length > 0) return inCurrentTerm;

  // Between terms the calendar says one thing and Gradescope another; fall back
  // to the newest term Gradescope lists rather than showing nothing.
  const newest = Math.max(...courses.map((c) => termSortKey(c.termCode ?? "")).filter((k) => k < Number.MAX_SAFE_INTEGER), -1);
  return courses.filter((c) => c.termCode !== null && termSortKey(c.termCode) === newest);
}

/** Gradescope assignments due in the next `days` days, across current courses. */
export async function fetchGradescopeTasks(
  days: number,
  now: Date = new Date(),
): Promise<Task[]> {
  const { html } = await getHtml("/account");
  const courses = parseCourses(html);

  // An authenticated account page always has at least the course list
  // container; zero courses with no error is a layout change or a landing page.
  if (courses.length === 0 && !/courseList/.test(html)) {
    throw new GradescopeSessionExpiredError();
  }

  const end = now.getTime() + days * 24 * 60 * 60 * 1000;
  const tasks: Task[] = [];

  for (const course of currentCourses(courses, now)) {
    const page = await getHtml(`/courses/${course.id}`);
    tasks.push(...parseAssignments(page.html, course));
  }

  return tasks
    .filter((task) => {
      if (!task.dueAt) return false;
      const due = new Date(task.dueAt).getTime();
      return due >= now.getTime() && due <= end;
    })
    .sort(byDueDate);
}

/**
 * Handouts for the file archive. Never throws: any failure, including a
 * signed-out session, comes back in `errors` so Canvas files are unaffected.
 */
export async function fetchGradescopeFiles(
  now: Date = new Date(),
  signal?: AbortSignal,
): Promise<GradescopeListing> {
  try {
    const { html } = await getHtml("/account");
    const courses = parseCourses(html);
    if (courses.length === 0 && !/courseList/.test(html)) throw new GradescopeSessionExpiredError();
    return await listGradescopeFiles(
      currentCourses(courses, now),
      async (path) => (await getHtml(path)).html,
      signal,
    );
  } catch (error) {
    return { courses: [], errors: [(error as Error).message] };
  }
}
