/**
 * What to ask Canvas for, and in what order.
 *
 * `client.ts` knows how to make an authenticated, paginated, rate-limit-aware
 * GET. This module knows which GETs are worth making.
 */

import type { CanvasUser, Course, Task } from "@/src/types/canvas";
import { getAll, getOne } from "./client";
import { AccessDeniedError, NotFoundError } from "./errors";
import { normalizeCourse, normalizePlannerItem, normalizeUser } from "./normalize";
import type { TaskRead } from "@/src/lib/source-read";
import { taskWindow, inTaskWindow } from "@/src/lib/task-window";
import { byDueDate } from "@/src/lib/task-status";
import { termSortKey } from "./terms";

/** How far ahead "Upcoming" looks. */
export const UPCOMING_DAYS = 14;

/** `GET /api/v1/users/self` — the cheapest authenticated request Canvas offers. */
export async function fetchUser(): Promise<CanvasUser> {
  return normalizeUser(await getOne<Record<string, unknown>>("/users/self"));
}

/**
 * `GET /api/v1/courses` — every course with an active enrollment.
 *
 * `include[]=term` is not optional: without it the response carries only an
 * opaque `enrollment_term_id`, and the term code shown in the UI is derived
 * from the term's *name* and *start date*.
 */
export async function fetchActiveCourses(): Promise<Course[]> {
  const raw = await getAll<Record<string, unknown>>("/courses", {
    enrollment_state: "active",
    "include[]": ["term", "teachers"],
  });

  return raw
    .map(normalizeCourse)
    .filter((course) => course.id > 0)
    .sort((a, b) => {
      const term = termSortKey(b.term.code) - termSortKey(a.term.code);
      return term !== 0 ? term : a.courseCode.localeCompare(b.courseCode);
    });
}

/**
 * Everything due in the next `days` days, across every course.
 *
 * Uses `GET /api/v1/planner/items`, which is **user-scoped** — one request
 * covers all courses, rather than three requests per course for assignments,
 * quizzes and discussions separately. For five courses that is 1 request
 * instead of 15. See `extension/ARCHITECTURE.md` §4.
 *
 * The planner is also precisely the right shape: it returns the things that
 * carry a date, already merged, with the current user's submission state
 * attached. Items that are not tasks (wiki pages, planner notes, calendar
 * events) are filtered out during normalisation.
 */
export async function fetchUpcomingTasks(
  courses: Course[],
  days: number = UPCOMING_DAYS,
  now: Date = new Date(),
  overdueDays = 0,
): Promise<TaskRead> {
  const window = taskWindow(now, days, overdueDays);

  let raw: Record<string, unknown>[];
  try {
    raw = await getAll<Record<string, unknown>>("/planner/items", {
      start_date: new Date(window.from).toISOString(),
      end_date: new Date(window.to).toISOString(),
    });
  } catch (error) {
    // This request is user-scoped. Denial is not proof that no course has deadlines.
    if (error instanceof AccessDeniedError || error instanceof NotFoundError) {
      return { tasks: [], complete: false, unavailableCourseIds: courses.map((course) => course.id), error };
    }
    throw error;
  }

  const lookup = new Map(courses.map((course) => [course.id, course]));

  const tasks = raw
    .map((item) => normalizePlannerItem(item, lookup))
    .filter((task): task is Task => task !== null)
    // The planner respects its own window, but an item whose due date was
    // nudged after the fact can still arrive outside it.
    .filter((task) => inTaskWindow(task.dueAt, window))
    .sort(byDueDate);
  return { tasks, complete: true, unavailableCourseIds: [], error: null };
}
