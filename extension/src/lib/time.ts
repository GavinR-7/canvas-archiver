/**
 * Formatting Canvas timestamps for display.
 *
 * Canvas timestamps are stored exactly as received — ISO 8601, UTC. All
 * conversion to the viewer's timezone happens here, at render.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **Every function takes `now` explicitly.** Anything time-relative is only
 *    correct for the instant it was computed, and a value computed at 11:58 PM
 *    is wrong two minutes later. Passing `now` in makes the staleness visible
 *    to the caller and the behaviour testable without mocking the clock.
 * 2. **Callers never assemble sentences.** `describeDue` returns a complete,
 *    grammatical phrase. An earlier version had the popup prefix `"next "` to
 *    whatever came back, which produced "next today" and "next fri, sep 25".
 *    Fragments that callers glue together will eventually be glued wrongly.
 */

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Local calendar day, e.g. `"Wed, Sep 30"`. */
export function formatDay(isoTimestamp: string): string {
  return dayFormatter.format(new Date(isoTimestamp));
}

/** Local time of day, e.g. `"11:59 PM"`. */
export function formatTime(isoTimestamp: string): string {
  return timeFormatter.format(new Date(isoTimestamp));
}

/**
 * Stable key for grouping by local calendar day, e.g. `"2026-09-25"`.
 *
 * Built from local date parts rather than `toISOString()`, which would regroup
 * by UTC day and push an 11:59 PM deadline into tomorrow for anyone west of
 * Greenwich.
 */
export function localDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Midnight at the start of the local day containing `value`. */
function startOfLocalDay(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Whole local calendar days from `now` to `isoTimestamp`.
 *
 * `0` is today, `1` tomorrow, `-1` yesterday. Counts *calendar* boundaries
 * crossed, not 24-hour periods: 11 PM tonight to 1 AM tomorrow is 1, not 0.
 * That is what makes a label flip the moment midnight passes, which is the
 * behaviour a due-date list needs.
 */
export function calendarDayOffset(isoTimestamp: string, now: Date): number {
  const from = startOfLocalDay(now).getTime();
  const to = startOfLocalDay(isoTimestamp).getTime();
  // Divide before rounding so a DST shift (a 23- or 25-hour day) still lands
  // on a whole number.
  return Math.round((to - from) / 86_400_000);
}

/** `"Today"`, `"Tomorrow"`, `"Yesterday"`, or the formatted day. */
export function relativeDay(isoTimestamp: string, now: Date): string {
  switch (calendarDayOffset(isoTimestamp, now)) {
    case 0:
      return "Today";
    case 1:
      return "Tomorrow";
    case -1:
      return "Yesterday";
    default:
      return formatDay(isoTimestamp);
  }
}

/** `"in 3 days"` / `"2 days ago"`, for an at-a-glance column. */
export function relativeDistance(isoTimestamp: string, now: Date): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const deltaMs = new Date(isoTimestamp).getTime() - now.getTime();
  const absMs = Math.abs(deltaMs);

  // Thresholds are compared against the raw delta, not a rounded one: rounding
  // 30 minutes to hours first gives 1, which then fails a `< 1 hour` check and
  // reports "in 1 hour".
  if (absMs < 3_600_000) return rtf.format(Math.round(deltaMs / 60_000), "minute");
  if (absMs < 86_400_000) return rtf.format(Math.round(deltaMs / 3_600_000), "hour");

  // Beyond a day, count calendar days rather than 24-hour blocks, so this
  // agrees with the "Tomorrow" heading rather than contradicting it.
  return rtf.format(calendarDayOffset(isoTimestamp, now), "day");
}

/**
 * A complete phrase describing when something is due.
 *
 * Grammatical on its own. Callers render it as-is and never prepend anything —
 * see the module docstring for what happens when they do.
 */
export function describeDue(isoTimestamp: string | null, now: Date): string {
  if (!isoTimestamp) return "No due date";

  const due = new Date(isoTimestamp);
  if (Number.isNaN(due.getTime())) return "No due date";

  const offset = calendarDayOffset(isoTimestamp, now);
  const time = formatTime(isoTimestamp);

  if (due.getTime() < now.getTime()) {
    if (offset === 0) return `Due ${time} today`;
    if (offset === -1) return `Was due yesterday, ${time}`;
    return `Was due ${formatDay(isoTimestamp)}`;
  }

  if (offset === 0) return `Due today, ${time}`;
  if (offset === 1) return `Due tomorrow, ${time}`;
  if (offset <= 6) return `Due ${formatDay(isoTimestamp)}, ${time}`;
  return `Due ${formatDay(isoTimestamp)}`;
}
