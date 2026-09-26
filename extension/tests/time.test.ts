/**
 * Time formatting.
 *
 * Every `now` and every due date here is built with `new Date(y, m, d, ...)`,
 * which constructs in *local* time. That makes the suite timezone-independent:
 * it asserts the same things whether CI runs in UTC or the author runs in
 * America/New_York. The midnight-rollover cases are the ones that matter —
 * they are the bug this module was rewritten for.
 */

import { describe, expect, it } from "vitest";
import {
  calendarDayOffset,
  describeDue,
  localDayKey,
  relativeDay,
  relativeDistance,
} from "@/src/lib/time";

/** Local-time constructor. Month is 1-based here, unlike Date. */
const local = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

const iso = (date: Date) => date.toISOString();

describe("calendarDayOffset", () => {
  const now = local(2026, 9, 25, 14, 0); // Fri 25 Sep, 2pm

  it.each([
    [local(2026, 9, 25, 23, 59), 0, "later today"],
    [local(2026, 9, 25, 0, 1), 0, "earlier today"],
    [local(2026, 9, 26, 0, 1), 1, "just after midnight tonight"],
    [local(2026, 9, 24, 23, 59), -1, "just before midnight yesterday"],
    [local(2026, 10, 2, 9, 0), 7, "a week out"],
  ])("%s -> %i (%s)", (due, expected) => {
    expect(calendarDayOffset(iso(due), now)).toBe(expected);
  });

  it("counts calendar boundaries, not 24-hour periods", () => {
    // Two hours apart, but a day boundary sits between them.
    const late = local(2026, 9, 25, 23, 0);
    const early = local(2026, 9, 26, 1, 0);
    expect(calendarDayOffset(iso(early), late)).toBe(1);
  });
});

describe("relativeDay", () => {
  const now = local(2026, 9, 25, 14, 0);

  it.each([
    [local(2026, 9, 25, 23, 59), "Today"],
    [local(2026, 9, 26, 9, 0), "Tomorrow"],
    [local(2026, 9, 24, 9, 0), "Yesterday"],
  ])("labels %s as %s", (due, expected) => {
    expect(relativeDay(iso(due), now)).toBe(expected);
  });

  it("falls back to a formatted date further out", () => {
    expect(relativeDay(iso(local(2026, 9, 30, 9, 0)), now)).toMatch(/Sep 30/);
  });
});

describe("the midnight rollover", () => {
  // The reported bug: at 12:01 AM the page still showed 11:59 PM items under
  // "Today". The label must depend on `now`, and must flip when it changes.
  const due = local(2026, 9, 25, 23, 59);

  it("reads Today at 11:58 PM", () => {
    expect(relativeDay(iso(due), local(2026, 9, 25, 23, 58))).toBe("Today");
  });

  it("reads Yesterday two minutes later, at 12:01 AM", () => {
    expect(relativeDay(iso(due), local(2026, 9, 26, 0, 1))).toBe("Yesterday");
  });

  it("groups into a different day key either side of midnight", () => {
    expect(localDayKey(iso(due))).toBe("2026-09-25");
    expect(localDayKey(local(2026, 9, 26, 0, 1))).toBe("2026-09-26");
  });

  it("stops describing a passed deadline as upcoming", () => {
    expect(describeDue(iso(due), local(2026, 9, 25, 23, 58))).toMatch(/^Due today/);
    expect(describeDue(iso(due), local(2026, 9, 26, 0, 1))).toMatch(/^Was due yesterday/);
  });
});

describe("describeDue", () => {
  const now = local(2026, 9, 25, 14, 0);

  it("returns a complete phrase that needs no prefix", () => {
    // The old bug: the popup prepended "next " to a fragment, producing
    // "next today" and "next fri, sep 25". Each of these stands alone.
    expect(describeDue(iso(local(2026, 9, 25, 23, 59)), now)).toBe("Due today, 11:59 PM");
    expect(describeDue(iso(local(2026, 9, 26, 23, 59)), now)).toBe("Due tomorrow, 11:59 PM");
    expect(describeDue(iso(local(2026, 9, 30, 9, 0)), now)).toMatch(/^Due \w+, Sep 30, 9:00 AM$/);
  });

  it("never emits a bare weekday that reads as a fragment", () => {
    for (const day of [26, 27, 28, 30]) {
      const phrase = describeDue(iso(local(2026, 9, day, 9, 0)), now);
      expect(phrase.startsWith("Due")).toBe(true);
      expect(`next ${phrase.toLowerCase()}`).not.toBe(phrase); // sanity: prefixing is wrong
    }
  });

  it("uses past tense once the deadline has gone", () => {
    expect(describeDue(iso(local(2026, 9, 20, 9, 0)), now)).toMatch(/^Was due/);
    expect(describeDue(iso(local(2026, 9, 25, 9, 0)), now)).toBe("Due 9:00 AM today");
  });

  it("handles a missing or unparseable date", () => {
    expect(describeDue(null, now)).toBe("No due date");
    expect(describeDue("not-a-date", now)).toBe("No due date");
  });
});

describe("relativeDistance", () => {
  const now = local(2026, 9, 25, 14, 0);

  it("agrees with the day heading rather than contradicting it", () => {
    // 11 PM tonight is "in 9 hours"; 1 AM tomorrow must not also be "in 11
    // hours" while its heading says Tomorrow.
    expect(relativeDistance(iso(local(2026, 9, 27, 1, 0)), now)).toBe("in 2 days");
    expect(relativeDay(iso(local(2026, 9, 27, 1, 0)), now)).toMatch(/Sep 27/);
  });

  it("uses hours inside a day and minutes inside an hour", () => {
    expect(relativeDistance(iso(local(2026, 9, 25, 18, 0)), now)).toBe("in 4 hours");
    expect(relativeDistance(iso(local(2026, 9, 25, 14, 30)), now)).toBe("in 30 minutes");
  });
});
