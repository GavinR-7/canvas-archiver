import { describe, expect, it } from "vitest";
import {
  UNKNOWN_TERM,
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
