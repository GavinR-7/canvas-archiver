/**
 * Formatting Canvas timestamps for display.
 *
 * Canvas timestamps are stored exactly as received — ISO 8601, UTC. All
 * conversion to the viewer's timezone happens here, at render, which is why
 * these helpers take an ISO string and return a string rather than mutating
 * anything.
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

/** Local calendar day, e.g. `"Wed, Feb 18"`. */
export function formatDay(isoTimestamp: string): string {
  return dayFormatter.format(new Date(isoTimestamp));
}

/** Local time of day, e.g. `"11:59 PM"`. */
export function formatTime(isoTimestamp: string): string {
  return timeFormatter.format(new Date(isoTimestamp));
}

/** Stable key for grouping tasks by local calendar day. */
export function localDayKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  // Build from local parts, not toISOString, which would regroup by UTC day
  // and split an 8pm-local deadline into the following day.
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `"Today"`, `"Tomorrow"`, or the formatted day. */
export function relativeDay(isoTimestamp: string, now: Date = new Date()): string {
  const key = localDayKey(isoTimestamp);
  if (key === localDayKey(now.toISOString())) return "Today";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === localDayKey(tomorrow.toISOString())) return "Tomorrow";

  return formatDay(isoTimestamp);
}

/** `"in 3 days"` / `"2 days ago"`, for the at-a-glance column. */
export function relativeDistance(isoTimestamp: string, now: Date = new Date()): string {
  const deltaMs = new Date(isoTimestamp).getTime() - now.getTime();
  const deltaHours = Math.round(deltaMs / (60 * 60 * 1000));

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, "hour");
  return rtf.format(Math.round(deltaHours / 24), "day");
}
