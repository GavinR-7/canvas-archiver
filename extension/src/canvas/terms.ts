/**
 * Short term codes (`FA25`, `SP26`) from Canvas term data.
 *
 * Direct port of `cli/src/canvas_archiver/terms.py`. Canvas institutions spell
 * one term several ways — `"Fall 2025"`, `"2025FA"`, `"FA25"`, and the
 * catch-all `"Default Term"` — and all of them must collapse to one code.
 *
 * Resolution order: parse the name, then fall back to the month of `startAt`,
 * then `NOTERM`. Pure logic, no I/O.
 */

import type { Course, IsoTimestamp, Term } from "@/src/types/canvas";

export const UNKNOWN_TERM = "NOTERM";

const SEASONS: Record<string, string> = {
  fall: "FA",
  autumn: "FA",
  fa: "FA",
  spring: "SP",
  sp: "SP",
  summer: "SU",
  su: "SU",
  winter: "WI",
  wi: "WI",
  january: "WI",
  jan: "WI",
};

/**
 * Month to season, following Cornell's calendar: January is the winter
 * session, February–May spring, June–July summer, August–December fall.
 */
const MONTH_TO_SEASON: Record<number, string> = {
  1: "WI", 2: "SP", 3: "SP", 4: "SP", 5: "SP", 6: "SU",
  7: "SU", 8: "FA", 9: "FA", 10: "FA", 11: "FA", 12: "FA",
};

// Longest-first, so "fall" is tried before "fa".
const ALTERNATION = Object.keys(SEASONS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// "Fall 2025", "Fall '25", "FA25". No boundary after the season group:
// "FA25" has none between "A" and "2".
const NAME_THEN_YEAR = new RegExp(`\\b(${ALTERNATION})[\\s\\-_/]*'?(\\d{2,4})\\b`, "i");
// "2025FA", "2025 Fall", "26-SP"
const YEAR_THEN_NAME = new RegExp(`\\b(\\d{2,4})[\\s\\-_/]*(${ALTERNATION})\\b`, "i");

const twoDigitYear = (raw: string) => raw.trim().slice(-2).padStart(2, "0");

/** Extract a term code from a Canvas term name, or `null` if unparseable. */
export function termCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;

  const forward = NAME_THEN_YEAR.exec(name);
  if (forward?.[1] && forward[2]) {
    return `${SEASONS[forward[1].toLowerCase()]}${twoDigitYear(forward[2])}`;
  }

  const backward = YEAR_THEN_NAME.exec(name);
  if (backward?.[1] && backward[2]) {
    return `${SEASONS[backward[2].toLowerCase()]}${twoDigitYear(backward[1])}`;
  }

  return null;
}

/** Derive a term code from a term start date, or `null` if unusable. */
export function termCodeFromDate(startAt: IsoTimestamp | null | undefined): string | null {
  if (!startAt?.trim()) return null;

  const parsed = new Date(startAt);
  if (Number.isNaN(parsed.getTime())) return null;

  // getUTCMonth is 0-based; Canvas timestamps are UTC.
  const season = MONTH_TO_SEASON[parsed.getUTCMonth() + 1];
  if (!season) return null;

  return `${season}${String(parsed.getUTCFullYear() % 100).padStart(2, "0")}`;
}

/** Resolve Canvas term data to a `Term` whose `code` is always usable. */
export function resolveTerm(raw: {
  id?: number | null;
  name?: string | null;
  start_at?: string | null;
  end_at?: string | null;
} | null | undefined): Term {
  const name = raw?.name ?? null;
  const startAt = raw?.start_at ?? null;

  return {
    id: raw?.id ?? null,
    name,
    startAt,
    endAt: raw?.end_at ?? null,
    code: termCodeFromName(name) ?? termCodeFromDate(startAt) ?? UNKNOWN_TERM,
  };
}

/**
 * Chronological sort key, oldest first. `NOTERM` sorts last.
 *
 * Within a year, seasons run winter → spring → summer → fall, matching how an
 * academic year actually goes.
 */
export function termSortKey(code: string): number {
  const order: Record<string, number> = { WI: 0, SP: 1, SU: 2, FA: 3 };
  const match = /^([A-Z]{2})(\d{2})$/.exec(code);
  if (!match?.[1] || !match[2]) return Number.MAX_SAFE_INTEGER;
  return Number(match[2]) * 10 + (order[match[1]] ?? 9);
}

// --------------------------------------------------------------------------
// Which term is it now?
// --------------------------------------------------------------------------

/**
 * The term code for the current date, e.g. `"FA26"` in late September 2026.
 *
 * Uses *local* month and year, unlike {@link termCodeFromDate}, which reads
 * UTC because it parses Canvas's UTC term timestamps. The two only disagree
 * within a few hours of a month boundary, but "what term is it for me right
 * now" is a local question.
 */
export function currentTermCode(now: Date): string {
  const season = MONTH_TO_SEASON[now.getMonth() + 1];
  if (!season) return UNKNOWN_TERM;
  return `${season}${String(now.getFullYear() % 100).padStart(2, "0")}`;
}

/**
 * Split courses into the current term and everything else.
 *
 * Canvas reports an enrollment as `active` long after a course matters — a
 * 2018 orientation module stays active forever — so "active" is not a useful
 * default for a course list. Term is.
 *
 * Resolution:
 *
 * 1. Prefer courses whose term matches {@link currentTermCode}.
 * 2. If none match — which happens during breaks, when the calendar says
 *    summer but the only enrolments are for the coming autumn — fall back to
 *    the newest term present, so the list is never empty for the wrong reason.
 * 3. A course whose term has an `endAt` in the past is never current, even if
 *    its code matches. This catches a mislabelled term.
 * 4. Courses with no identifiable term (`NOTERM`) go to `other`. They cannot
 *    be confirmed current, and the toggle exists to reveal them.
 */
export function partitionByCurrentTerm(
  courses: Course[],
  now: Date,
): { current: Course[]; other: Course[] } {
  const hasEnded = (course: Course): boolean => {
    const endAt = course.term.endAt;
    if (!endAt) return false;
    const parsed = new Date(endAt).getTime();
    return !Number.isNaN(parsed) && parsed < now.getTime();
  };

  const dated = courses.filter((c) => c.term.code !== UNKNOWN_TERM);
  const wanted = currentTermCode(now);

  let target: string | null = dated.some((c) => c.term.code === wanted) ? wanted : null;

  if (target === null && dated.length > 0) {
    // Newest term present, so a break between terms still shows something.
    target = dated.reduce((newest, c) =>
      termSortKey(c.term.code) > termSortKey(newest.term.code) ? c : newest,
    ).term.code;
  }

  const current: Course[] = [];
  const other: Course[] = [];

  for (const course of courses) {
    if (course.term.code === target && !hasEnded(course)) current.push(course);
    else other.push(course);
  }

  return { current, other };
}
