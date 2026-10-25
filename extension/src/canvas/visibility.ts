/**
 * Which courses a list shows by default.
 *
 * Canvas keeps an enrollment `active` for years (a 2018 orientation module, a
 * hazing-prevention training), so the raw course list buries the real classes.
 * This decides visibility only. It never changes what is stored, archived or
 * synced: a hidden course that was selected stays selected, and "Show all"
 * reveals everything.
 *
 * A course is *current* when:
 *
 * 1. its term covers today (Canvas term start/end), or, when the term has no
 *    dates at all, its term code (from the term name, or its start date)
 *    matches the current term such as `FA26`; and
 * 2. it is not administrative: orientation, training, compliance and module
 *    courses are hidden, unless the course carries a real catalog code
 *    (`ECE 3140`), which is never hidden by the name heuristic.
 *
 * A course with no usable term is hidden by default (it cannot be confirmed
 * current) and is one click away under Show all.
 */

import type { Course } from "@/src/types/canvas";
import { UNKNOWN_TERM, currentTermCode } from "./terms";

export type HiddenReason = "no-term" | "term-over" | "term-not-started" | "other-term" | "administrative";

export interface Visibility {
  visible: boolean;
  reason: HiddenReason | null;
}

// "orientation", "training", "compliance", "module" as whole words; a catalog
// course such as "ECE 3140 Embedded Systems" has none of them.
const ADMIN_WORDS = /\b(orientation|training|trainings|compliance|modules?|onboarding)\b/i;
// A real catalog code: letters then a four digit number ("ECE 3140", "CS3700").
const CATALOG_CODE = /^[A-Za-z]{2,6}\s*-?\s*\d{4}[A-Za-z]?\b/;

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function courseVisibility(course: Course, now: Date): Visibility {
  const hide = (reason: HiddenReason): Visibility => ({ visible: false, reason });

  if (!CATALOG_CODE.test(course.courseCode.trim()) && ADMIN_WORDS.test(`${course.name} ${course.courseCode}`)) {
    return hide("administrative");
  }

  const start = timeOf(course.term.startAt);
  const end = timeOf(course.term.endAt);
  const t = now.getTime();

  if (start !== null || end !== null) {
    if (end !== null && end < t) return hide("term-over");
    if (start !== null && start > t) return hide("term-not-started");
    return { visible: true, reason: null };
  }

  if (course.term.code === UNKNOWN_TERM) return hide("no-term");
  return course.term.code === currentTermCode(now) ? { visible: true, reason: null } : hide("other-term");
}

export interface CourseSplit {
  shown: Course[];
  hidden: Array<{ course: Course; reason: HiddenReason }>;
}

/** Split into the default list and what Show all adds. Order is preserved. */
export function splitCourses(courses: Course[], now: Date): CourseSplit {
  const shown: Course[] = [];
  const hidden: CourseSplit["hidden"] = [];
  for (const course of courses) {
    const v = courseVisibility(course, now);
    if (v.visible) shown.push(course);
    else hidden.push({ course, reason: v.reason as HiddenReason });
  }
  return { shown, hidden };
}

export const REASON_TEXT: Record<HiddenReason, string> = {
  "no-term": "no term",
  "term-over": "term is over",
  "term-not-started": "term has not started",
  "other-term": "a different term",
  administrative: "administrative course",
};

/**
 * The ids a course picker has selected. Before the user chooses anything it is
 * the current-term list; after, it is exactly their set, including courses the
 * filter now hides, so collapsing the list never drops a selection.
 */
export function selectedIds(current: Course[], chosen: Set<number> | null): Set<number> {
  return chosen ?? new Set(current.map((c) => c.id));
}
