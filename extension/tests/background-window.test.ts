import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";

const mocks = vi.hoisted(() => ({
  canvas: vi.fn(async () => ({ tasks: [], complete: true, unavailableCourseIds: [], error: null })), gradescope: vi.fn(async () => []),
  syllabus: vi.fn(async () => ({ tasks: [], complete: true, unavailableCourseIds: [], error: null })), ed: vi.fn(async () => []), save: vi.fn(async () => {}),
}));
vi.mock("@/src/canvas/api", () => ({ fetchUser: async () => ({ id: 1 }), fetchActiveCourses: async () => [], fetchUpcomingTasks: mocks.canvas }));
vi.mock("@/src/gradescope/api", () => ({ fetchGradescopeTasks: mocks.gradescope }));
vi.mock("@/src/dates/syllabus", () => ({ fetchSyllabusTasks: mocks.syllabus }));
vi.mock("@/src/ed/api", () => ({ fetchEdTasks: mocks.ed }));
vi.mock("@/src/consent/consent", () => ({ hasConsent: async () => true }));
vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }), minutesUntilHour: () => 1 }));
vi.mock("@/src/lib/storage", () => ({ loadSnapshot: async () => EMPTY_SNAPSHOT, saveSnapshot: mocks.save }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function refresh() {
  let listener!: (message: { type: string }, sender: unknown, reply: (snapshot: Snapshot) => void) => boolean;
  vi.stubGlobal("defineBackground", (setup: () => void) => setup());
  vi.stubGlobal("chrome", {
    alarms: { get: async () => ({}), clear: async () => {}, onAlarm: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: { onChanged: { addListener: vi.fn() } },
  });
  await import("@/entrypoints/background");
  return new Promise<Snapshot>((resolve) => listener({ type: "REFRESH" }, {}, resolve));
}

describe("background scheduler window", () => {
  it("supplies every source with the same clock and seven-past/sixty-ahead window", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-25T12:00:00Z");
    vi.setSystemTime(now);
    const result = await refresh();
    expect(result.fetchedAt).toBe(now.toISOString());
    expect(mocks.canvas).toHaveBeenCalledWith([], 60, now, 7);
    expect(mocks.gradescope).toHaveBeenCalledWith(60, now, 7);
    expect(mocks.syllabus).toHaveBeenCalledWith([], 60, now, 7);
    expect(mocks.ed).toHaveBeenCalledWith([], 60, now, 7);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ syllabusError: null }));
  });
  it("records a syllabus failure while preserving a usable Canvas snapshot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.syllabus.mockRejectedValueOnce(new TypeError("offline"));
    try {
      const result = await refresh();
      expect(result.error).toBeNull();
      expect(result.syllabusError).toMatchObject({ kind: "network" });
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ syllabusError: result.syllabusError }));
    } finally { warn.mockRestore(); }
  });
});
