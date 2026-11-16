import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ARCHIVE_SCHEDULE_KEY, DEFAULT_ARCHIVE_SCHEDULE, type ArchiveSchedule } from "@/src/files/schedule";

const ARCHIVE_ALARM = "archive-schedule";
const DAILY = 24 * 60;
const WEEKLY = 7 * DAILY;

type Alarm = { scheduledTime: number; periodInMinutes: number };
type StorageChange = (changes: Record<string, unknown>, area: string) => void;

vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }) }));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

function setup(schedule: ArchiveSchedule, existing?: Alarm) {
  let current = schedule;
  let alarm = existing;
  let listener!: StorageChange;
  const setAlarm = vi.fn(async (_name: string, info: { delayInMinutes: number; periodInMinutes: number }) => {
    alarm = { scheduledTime: info.delayInMinutes * 60_000, periodInMinutes: info.periodInMinutes };
  });
  const clearAlarm = vi.fn(async () => { alarm = undefined; });
  const getArchive = vi.fn(async () => alarm);

  vi.stubGlobal("defineBackground", (run: () => void) => run());
  vi.stubGlobal("chrome", {
    alarms: {
      get: async (name: string) => name === ARCHIVE_ALARM ? getArchive() : {},
      create: setAlarm,
      clear: async (name: string) => { if (name === ARCHIVE_ALARM) await clearAlarm(); },
      onAlarm: { addListener: vi.fn() },
    },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() } },
    storage: {
      local: { get: async (key: string) => key === ARCHIVE_SCHEDULE_KEY ? { [key]: current } : {} },
      onChanged: { addListener: (fn: StorageChange) => { listener = fn; } },
    },
  });
  return {
    get alarm() { return alarm; },
    setAlarm,
    clearAlarm,
    getArchive,
    async wake() {
      vi.resetModules();
      await import("@/entrypoints/background");
      await setImmediate();
    },
    change(next: ArchiveSchedule, area = "local") {
      const previous = current;
      if (area === "local") current = next;
      listener({ [ARCHIVE_SCHEDULE_KEY]: { oldValue: previous, newValue: next } }, area);
      return setImmediate();
    },
  };
}

const daily: ArchiveSchedule = { ...DEFAULT_ARCHIVE_SCHEDULE, frequency: "daily" };
const nextRun: Alarm = { scheduledTime: 42_000, periodInMinutes: DAILY };

it("preserves the scheduled time across worker wakes and non-frequency edits", async () => {
  const fixture = setup(daily, nextRun);
  await fixture.wake();
  await fixture.wake();
  await fixture.change({ ...daily, courseIds: [7], location: "downloads" });
  expect(fixture.alarm).toEqual(nextRun);
  expect(fixture.setAlarm).not.toHaveBeenCalled();
  expect(fixture.clearAlarm).not.toHaveBeenCalled();
});

it("starts a missing schedule and replaces it only when the frequency changes", async () => {
  const fixture = setup(daily);
  await fixture.wake();
  expect(fixture.setAlarm).toHaveBeenCalledExactlyOnceWith(ARCHIVE_ALARM, { delayInMinutes: DAILY, periodInMinutes: DAILY });

  const weekly = { ...daily, frequency: "weekly" } as const;
  await fixture.change(weekly, "sync");
  expect(fixture.setAlarm).toHaveBeenCalledTimes(1);
  await fixture.change(weekly);
  expect(fixture.setAlarm).toHaveBeenLastCalledWith(ARCHIVE_ALARM, { delayInMinutes: WEEKLY, periodInMinutes: WEEKLY });
  expect(fixture.setAlarm).toHaveBeenCalledTimes(2);
  expect(fixture.clearAlarm).not.toHaveBeenCalled();
});

it("clears the schedule when switched off and stays off on the next wake", async () => {
  const fixture = setup(daily, nextRun);
  await fixture.wake();
  await fixture.change(DEFAULT_ARCHIVE_SCHEDULE);
  expect(fixture.alarm).toBeUndefined();
  expect(fixture.clearAlarm).toHaveBeenCalledTimes(1);
  await fixture.wake();
  expect(fixture.setAlarm).not.toHaveBeenCalled();
});

it("applies a simultaneous switch off after the earlier startup check completes", async () => {
  const fixture = setup(daily);
  let release!: (alarm: undefined) => void;
  fixture.getArchive.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await fixture.wake();
  await fixture.change(DEFAULT_ARCHIVE_SCHEDULE);
  expect(fixture.getArchive).toHaveBeenCalledTimes(1);
  release(undefined);
  await setImmediate();
  expect(fixture.alarm).toBeUndefined();
  expect(fixture.clearAlarm).toHaveBeenCalledTimes(1);
});
