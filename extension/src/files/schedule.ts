/**
 * When the archive runs on its own.
 *
 * Off until the person picks a frequency. Course choice is either "whatever
 * is current when the run starts" or an explicit id list. The folder itself
 * stays in IndexedDB (the same handle the Files page uses); this only records
 * whether a run should use that folder or the browser Downloads directory.
 */

import { splitCourses } from "@/src/canvas/visibility";
import type { Course } from "@/src/types/canvas";

export const ARCHIVE_SCHEDULE_KEY = "archive.schedule";
const STATUS_KEY = "archive.schedule.status";

export const ARCHIVE_FREQUENCIES = ["off", "daily", "every-3-days", "weekly"] as const;
export type ArchiveFrequency = (typeof ARCHIVE_FREQUENCIES)[number];
export type ArchiveLocation = "folder" | "downloads";

export interface ArchiveSchedule {
  frequency: ArchiveFrequency;
  /**
   * `null` archives the current-term courses at run time.
   * An array archives those ids only, including ones the current-term filter
   * would hide, and archives nothing when it is empty.
   */
  courseIds: number[] | null;
  location: ArchiveLocation;
}

export const DEFAULT_ARCHIVE_SCHEDULE: ArchiveSchedule = {
  frequency: "off",
  courseIds: null,
  location: "folder",
};

export const FREQUENCY_LABEL: Record<ArchiveFrequency, string> = {
  off: "Off",
  daily: "Every day",
  "every-3-days": "Every 3 days",
  weekly: "Every week",
};

/** Minutes between runs, or null when the schedule is off. */
export function periodMinutes(frequency: ArchiveFrequency): number | null {
  switch (frequency) {
    case "off":
      return null;
    case "daily":
      return 24 * 60;
    case "every-3-days":
      return 3 * 24 * 60;
    case "weekly":
      return 7 * 24 * 60;
  }
}

function isFrequency(value: unknown): value is ArchiveFrequency {
  return typeof value === "string" && (ARCHIVE_FREQUENCIES as readonly string[]).includes(value);
}

function isCourseId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}

export function normalizeArchiveSchedule(stored: unknown): ArchiveSchedule {
  if (!stored || typeof stored !== "object") return DEFAULT_ARCHIVE_SCHEDULE;
  const raw = stored as { frequency?: unknown; courseIds?: unknown; location?: unknown };
  const courseIds = Array.isArray(raw.courseIds) ? [...new Set(raw.courseIds.filter(isCourseId))] : null;
  return {
    frequency: isFrequency(raw.frequency) ? raw.frequency : "off",
    courseIds,
    location: raw.location === "downloads" ? "downloads" : "folder",
  };
}

/** Courses a scheduled run should read. Restricted enrollments are never included. */
export function coursesToArchive(courses: Course[], schedule: ArchiveSchedule, now: Date): Course[] {
  const open = courses.filter((course) => !course.restricted);
  if (schedule.courseIds === null) return splitCourses(open, now).shown;
  const wanted = new Set(schedule.courseIds);
  return open.filter((course) => wanted.has(course.id));
}

export interface ArchiveScheduleStatus {
  at: string;
  ok: boolean;
  message: string;
}

export async function loadArchiveSchedule(): Promise<ArchiveSchedule> {
  try {
    return normalizeArchiveSchedule((await chrome.storage.local.get(ARCHIVE_SCHEDULE_KEY))[ARCHIVE_SCHEDULE_KEY]);
  } catch {
    return DEFAULT_ARCHIVE_SCHEDULE;
  }
}

export const saveArchiveSchedule = (schedule: ArchiveSchedule) =>
  chrome.storage.local.set({ [ARCHIVE_SCHEDULE_KEY]: normalizeArchiveSchedule(schedule) });

export async function loadArchiveScheduleStatus(): Promise<ArchiveScheduleStatus | null> {
  try {
    return ((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] as ArchiveScheduleStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

export const saveArchiveScheduleStatus = (status: ArchiveScheduleStatus) =>
  chrome.storage.local.set({ [STATUS_KEY]: status });
