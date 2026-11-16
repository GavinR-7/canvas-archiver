import { describe, expect, it } from "vitest";
import { coursesToArchive, normalizeArchiveSchedule, periodMinutes, type ArchiveSchedule } from "@/src/files/schedule";
import type { Course } from "@/src/types/canvas";

const now = new Date("2026-11-15T18:00:00Z");

function course(id: number, code: string, patch: Partial<Course> = {}): Course {
  return {
    id,
    name: code,
    courseCode: code,
    term: { id: 1, name: "Fall 2026", startAt: "2026-08-01T00:00:00Z", endAt: "2026-12-20T00:00:00Z", code: "FA26" },
    enrollmentState: "active",
    workflowState: "available",
    restricted: false,
    htmlUrl: `https://canvas.example/courses/${id}`,
    ...patch,
  };
}

const current = course(7, "ECE 3140");
const older = course(8, "CS 2110", {
  term: { id: 2, name: "Spring 2024", startAt: "2024-01-10T00:00:00Z", endAt: "2024-05-20T00:00:00Z", code: "SP24" },
});
const restricted = course(9, "INFO 1200", { restricted: true });

describe("archive schedule", () => {
  it("treats a missing or junk record as off, current courses, folder", () => {
    expect(normalizeArchiveSchedule(undefined)).toEqual({ frequency: "off", courseIds: null, location: "folder" });
    expect(normalizeArchiveSchedule({ frequency: "hourly", location: "desktop", courseIds: "all" })).toEqual({
      frequency: "off",
      courseIds: null,
      location: "folder",
    });
  });

  it("keeps an explicit course list and drops ids that are not positive integers", () => {
    expect(normalizeArchiveSchedule({ frequency: "weekly", location: "downloads", courseIds: [7, 7, 0, 1.5, "8"] })).toEqual({
      frequency: "weekly",
      location: "downloads",
      courseIds: [7],
    });
    expect(normalizeArchiveSchedule({ frequency: "daily", courseIds: [] }).courseIds).toEqual([]);
  });

  it("maps each frequency to one chrome.alarms period", () => {
    expect(periodMinutes("off")).toBeNull();
    expect(periodMinutes("daily")).toBe(24 * 60);
    expect(periodMinutes("every-3-days")).toBe(3 * 24 * 60);
    expect(periodMinutes("weekly")).toBe(7 * 24 * 60);
  });

  it("archives current courses until the person checks a list", () => {
    const courses = [current, older, restricted];
    const open: ArchiveSchedule = { frequency: "daily", courseIds: null, location: "folder" };
    expect(coursesToArchive(courses, open, now).map((item) => item.id)).toEqual([7]);
    expect(coursesToArchive(courses, { ...open, courseIds: [8, 9] }, now).map((item) => item.id)).toEqual([8]);
    expect(coursesToArchive(courses, { ...open, courseIds: [] }, now)).toEqual([]);
  });
});
