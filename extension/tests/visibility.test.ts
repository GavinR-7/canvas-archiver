import { describe, expect, it } from "vitest";
import type { Course } from "@/src/types/canvas";
import { resolveTerm } from "@/src/canvas/terms";
import { courseVisibility, selectedIds, splitCourses } from "@/src/canvas/visibility";

const NOW = new Date(2026, 9, 25, 13, 0); // Oct 25 2026, local

const FA26 = { id: 1, name: "Fall 2026", start_at: "2026-08-24T04:00:00Z", end_at: "2026-12-22T05:00:00Z" };
const SU18 = { id: 2, name: "Summer 2018", start_at: "2018-06-01T00:00:00Z", end_at: "2018-08-20T00:00:00Z" };

const course = (id: number, code: string, name: string, term: Parameters<typeof resolveTerm>[0]): Course =>
  ({
    id,
    name,
    courseCode: code,
    term: resolveTerm(term),
    enrollmentState: "active",
    workflowState: "available",
    restricted: false,
    htmlUrl: "",
  }) as Course;

const fixture = [
  course(10, "ECE 3140", "Embedded Systems", FA26),
  course(11, "CS 3700", "Networks", FA26),
  course(12, "ORIENT 0001", "New Student Orientation", SU18),
  course(13, "", "Alcohol Education Training Module", FA26),
  course(14, "HAZE", "Hazing Prevention Training", { id: 3, name: "Default Term" }),
  course(15, "PE 1300", "Physical Education", null),
];

describe("current-term filter", () => {
  it("default shows only the FA26 academic courses", () => {
    const { shown, hidden } = splitCourses(fixture, NOW);
    expect(shown.map((c) => c.id)).toEqual([10, 11]);
    expect(hidden.map((h) => [h.course.id, h.reason])).toEqual([
      [12, "term-over"],
      [13, "administrative"],
      [14, "administrative"],
      [15, "no-term"],
    ]);
  });

  it("Show all is the whole list, nothing dropped or reordered", () => {
    const { shown, hidden } = splitCourses(fixture, NOW);
    expect(shown.length + hidden.length).toBe(fixture.length);
    expect(fixture.map((c) => c.id)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it("a real catalog course is never hidden by the administrative name heuristic", () => {
    const real = course(20, "ECE 4999", "Capstone Training Module Design", FA26);
    expect(courseVisibility(real, NOW).visible).toBe(true);
  });

  it("falls back to the term code when the term has no dates", () => {
    const named = course(21, "MATH 2930", "Differential Equations", { id: 4, name: "FA26" });
    const old = course(22, "MATH 1920", "Multivariable", { id: 5, name: "SP25" });
    expect(courseVisibility(named, NOW).visible).toBe(true);
    expect(courseVisibility(old, NOW)).toEqual({ visible: false, reason: "other-term" });
  });

  it("a term that has not started or has ended is hidden", () => {
    const next = course(23, "ECE 3250", "Signals", { id: 6, name: "Spring 2027", start_at: "2027-01-20T00:00:00Z", end_at: "2027-05-20T00:00:00Z" });
    expect(courseVisibility(next, NOW).reason).toBe("term-not-started");
  });

  it("selections survive: a chosen hidden course stays selected, the default is the current list", () => {
    const { shown } = splitCourses(fixture, NOW);
    expect([...selectedIds(shown, null)]).toEqual([10, 11]);
    const chosen = new Set([10, 12]); // 12 is the SU18 orientation, selected earlier via Show all
    expect(selectedIds(shown, chosen)).toBe(chosen);
    expect(fixture.filter((c) => selectedIds(shown, chosen).has(c.id)).map((c) => c.id)).toEqual([10, 12]);
  });
});
