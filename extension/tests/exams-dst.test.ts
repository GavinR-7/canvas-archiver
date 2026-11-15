import { beforeAll, describe, expect, it } from "vitest";
import type { Task } from "@/src/types/canvas";
import { inWindow, windowEnd } from "@/src/dates/exams";

// The Upcoming window is `days` local calendar days, like the Canvas reader's end date (setDate). An
// elapsed-hours cutoff loses or gains an hour across a DST change (Anvil T-499).
beforeAll(() => {
  process.env.TZ = "America/New_York";
  expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(240);
});

const due = (iso: string): Task => ({ id: "t", source: "canvas", kind: "assignment", dueAt: iso }) as Task;

describe("inWindow across DST", () => {
  it("fall back: a deadline in the extra hour at the end of the 14-day window is kept", () => {
    const now = new Date("2026-10-25T17:00:00Z"); // 13:00 EDT; Nov 1 2026 is the fall-back
    expect(windowEnd(now, 14).toISOString()).toBe("2026-11-08T18:00:00.000Z"); // 13:00 EST
    expect(inWindow(due("2026-11-08T17:30:00Z"), now, 14)).toBe(true); // 12:30 EST, old cutoff 17:00Z dropped it
    expect(inWindow(due("2026-11-08T18:00:00Z"), now, 14)).toBe(true);
    expect(inWindow(due("2026-11-08T18:01:00Z"), now, 14)).toBe(false);
  });

  it("spring forward: the window ends at the same wall-clock time, an hour earlier in elapsed time", () => {
    const now = new Date("2027-03-07T17:00:00Z"); // 12:00 EST; Mar 14 2027 is the spring-forward
    expect(windowEnd(now, 14).toISOString()).toBe("2027-03-21T16:00:00.000Z"); // 12:00 EDT
    expect(inWindow(due("2027-03-21T16:00:00Z"), now, 14)).toBe(true);
    expect(inWindow(due("2027-03-21T16:30:00Z"), now, 14)).toBe(false); // old cutoff 17:00Z kept it
  });

  it("no DST change in range: exactly 14 days", () => {
    const now = new Date("2026-09-01T16:00:00Z");
    expect(windowEnd(now, 14).toISOString()).toBe("2026-09-15T16:00:00.000Z");
  });
});
