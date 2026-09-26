import { describe, expect, it } from "vitest";
import type { Course } from "@/src/types/canvas";
import {
  UNKNOWN_TERM,
  currentTermCode,
  partitionByCurrentTerm,
  resolveTerm,
  termCodeFromDate,
  termCodeFromName,
  termSortKey,
} from "@/src/canvas/terms";

describe("termCodeFromName", () => {
  it.each([
    ["Fall 2025", "FA25"],
    ["fall 2025", "FA25"],
    ["Spring 2026", "SP26"],
    ["Summer 2025", "SU25"],
    ["Winter 2026", "WI26"],
    ["Autumn 2025", "FA25"],
    ["January 2026", "WI26"],
    ["2025FA", "FA25"],
    ["2025 Fall", "FA25"],
    ["2026-SP", "SP26"],
    ["FA25", "FA25"],
    ["SP-26", "SP26"],
    ["Fall '25", "FA25"],
    ["2025 Fall Semester (Ithaca)", "FA25"],
  ])("parses %s as %s", (name, expected) => {
    expect(termCodeFromName(name)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "Default Term", "Sandbox"])(
    "returns null for %s",
    (name) => {
      expect(termCodeFromName(name)).toBeNull();
    },
  );
});

describe("termCodeFromDate", () => {
  it.each([
    ["2025-08-25T04:00:00Z", "FA25"],
    ["2026-01-21T04:00:00Z", "WI26"],
    ["2026-02-02T04:00:00Z", "SP26"],
    ["2025-06-01T04:00:00Z", "SU25"],
  ])("maps %s to %s", (startAt, expected) => {
    expect(termCodeFromDate(startAt)).toBe(expected);
  });

  it.each([null, undefined, "", "not-a-date"])("returns null for %s", (value) => {
    expect(termCodeFromDate(value)).toBeNull();
  });
});

describe("resolveTerm", () => {
  it("prefers the name over the start date", () => {
    const term = resolveTerm({ id: 7, name: "Fall 2025", start_at: "2026-02-01T00:00:00Z" });
    expect(term.code).toBe("FA25");
    expect(term.id).toBe(7);
  });

  it("falls back to the start date when the name is unparseable", () => {
    expect(resolveTerm({ name: "Default Term", start_at: "2026-01-21T04:00:00Z" }).code)
      .toBe("WI26");
  });

  it("falls back to NOTERM", () => {
    expect(resolveTerm({ name: "Default Term" }).code).toBe(UNKNOWN_TERM);
    expect(resolveTerm(null).code).toBe(UNKNOWN_TERM);
  });
});

describe("termSortKey", () => {
  it("orders chronologically with NOTERM last", () => {
    const codes = ["FA25", "SP26", "WI26", "SU25", UNKNOWN_TERM, "FA24"];
    expect([...codes].sort((a, b) => termSortKey(a) - termSortKey(b))).toEqual([
      "FA24", "SU25", "FA25", "WI26", "SP26", UNKNOWN_TERM,
    ]);
  });
});

describe("currentTermCode", () => {
  it.each([
    [new Date(2026, 8, 26), "FA26"], // late September
    [new Date(2026, 0, 15), "WI26"], // January session
    [new Date(2026, 2, 3), "SP26"],  // March
    [new Date(2026, 5, 20), "SU26"], // June
  ])("maps %s to %s", (now, expected) => {
    expect(currentTermCode(now)).toBe(expected);
  });
});

describe("partitionByCurrentTerm", () => {
  const course = (id: number, code: string, endAt: string | null = null): Course =>
    ({
      id,
      name: `Course ${id}`,
      courseCode: `C ${id}`,
      term: { id: null, name: code, startAt: null, endAt, code },
      enrollmentState: "active",
      workflowState: "available",
      restricted: false,
      htmlUrl: "",
    }) as Course;

  const september2026 = new Date(2026, 8, 26);

  it("keeps only the current term by default", () => {
    // The reported bug: a 2018 orientation module is still `active` in Canvas
    // and was showing alongside this term's courses.
    const { current, other } = partitionByCurrentTerm(
      [course(1, "FA26"), course(2, "FA26"), course(3, "SU18"), course(4, "SP26")],
      september2026,
    );

    expect(current.map((c) => c.id)).toEqual([1, 2]);
    expect(other.map((c) => c.id)).toEqual([3, 4]);
  });

  it("falls back to the newest term when none matches today", () => {
    // Mid-August: the calendar says FA26 but enrolments are only SP26/SU26.
    const { current } = partitionByCurrentTerm(
      [course(1, "SP26"), course(2, "SU26")],
      september2026,
    );
    expect(current.map((c) => c.id)).toEqual([2]);
  });

  it("excludes a course whose term has already ended", () => {
    const { current, other } = partitionByCurrentTerm(
      [course(1, "FA26"), course(2, "FA26", "2026-09-01T00:00:00Z")],
      september2026,
    );
    expect(current.map((c) => c.id)).toEqual([1]);
    expect(other.map((c) => c.id)).toEqual([2]);
  });

  it("puts undatable courses in other rather than guessing", () => {
    const { current, other } = partitionByCurrentTerm(
      [course(1, "FA26"), course(2, UNKNOWN_TERM)],
      september2026,
    );
    expect(current.map((c) => c.id)).toEqual([1]);
    expect(other.map((c) => c.id)).toEqual([2]);
  });

  it("returns empty partitions for no courses rather than throwing", () => {
    expect(partitionByCurrentTerm([], september2026)).toEqual({ current: [], other: [] });
  });
});
