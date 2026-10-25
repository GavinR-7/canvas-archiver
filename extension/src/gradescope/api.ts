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

/** One Gradescope page may take this long; a hung request must not hold the UI. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The whole optional listing (every page of every course) gets this long. */
export const LISTING_BUDGET_MS = 60_000;

export async function getHtml(path: string, signal?: AbortSignal): Promise<{ html: string; url: string }> {
  const url = assertCanvasOrigin(`${GRADESCOPE_ORIGIN}${path}`, GRADESCOPE_ORIGIN);

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "text/html" },
    redirect: "follow",
    // Covers reading the body too, so a stalled response cannot outlive the timeout.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
 * Handouts for the file archive. Never throws and never outlasts `budgetMs`:
 * any failure, a signed-out session, or a request that never answers comes back
 * in `errors` (with whatever was listed before it) so Canvas files are unaffected.
 * The deadline is enforced twice: it aborts the in-flight fetch, and it ends the
 * wait even if something ignores the abort.
 */
export async function fetchGradescopeFiles(
  now: Date = new Date(),
  signal?: AbortSignal,
  budgetMs: number = LISTING_BUDGET_MS,
): Promise<GradescopeListing> {
  const listing: GradescopeListing = { courses: [], errors: [] };
  const budget = new AbortController();
  const stop = () => budget.abort();
  signal?.addEventListener("abort", stop);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      listing.errors.push(`Gradescope did not answer within ${Math.round(budgetMs / 1000)}s`);
      stop();
      resolve();
    }, budgetMs);
  });

  const work = (async () => {
    try {
      const { html } = await getHtml("/account", budget.signal);
      const courses = parseCourses(html);
      if (courses.length === 0 && !/courseList/.test(html)) throw new GradescopeSessionExpiredError();
      await listGradescopeFiles(
        currentCourses(courses, now),
        async (path) => (await getHtml(path, budget.signal)).html,
        budget.signal,
        listing,
      );
    } catch (error) {
      listing.errors.push((error as Error).message);
    }
  })();

  await Promise.race([work, deadline]);
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  // Detach: a late settle must not mutate what the caller now holds.
  return { courses: [...listing.courses], errors: [...listing.errors] };
}
