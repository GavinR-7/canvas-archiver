import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT } from "@/src/lib/messages";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), user: vi.fn(async () => ({ id: 1, name: "Student" })),
  courses: vi.fn(async () => []), tasks: vi.fn(async () => []),
}));
vi.mock("@/src/canvas/api", () => ({ fetchUser: mocks.user, fetchActiveCourses: mocks.courses, fetchUpcomingTasks: mocks.tasks, UPCOMING_DAYS: 14 }));
vi.mock("@/src/sync/run", () => ({ syncDue: mocks.sync }));
vi.mock("@/src/sync/settings", () => ({ loadSettings: async () => ({ enabled: true }) }));
vi.mock("@/src/schedule/model", () => ({ loadClasses: async () => [] }));
vi.mock("@/src/consent/consent", () => ({ hasConsent: async () => true }));
vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }), minutesUntilHour: () => 1 }));
vi.mock("@/src/gradescope/api", () => ({ fetchGradescopeTasks: async () => [] }));
vi.mock("@/src/dates/syllabus", () => ({ fetchSyllabusTasks: async () => [] }));
vi.mock("@/src/ed/api", () => ({ fetchEdTasks: async () => [] }));
vi.mock("@/src/lib/storage", () => ({ loadSnapshot: async () => EMPTY_SNAPSHOT, saveSnapshot: async () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("joins manual syncs arriving during an alarm's upload, then permits the next run", async () => {
  let release!: () => void;
  mocks.sync.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(null);
  let alarm!: (value: { name: string }) => void;
  let message!: (value: { type: string }, sender: unknown, reply: (value: unknown) => void) => boolean;
  vi.stubGlobal("defineBackground", (setup: () => void) => setup());
  vi.stubGlobal("chrome", {
    alarms: { get: async () => ({}), clear: async () => {}, onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: (fn: typeof message) => { message = fn; } } },
    storage: { onChanged: { addListener: vi.fn() } },
  });
  await import("@/entrypoints/background");
  alarm({ name: "refresh-and-sync" });
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  const reply = vi.fn();
  expect(message({ type: "SYNC_NOW" }, {}, reply)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.user).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
  const nextReply = vi.fn();
  message({ type: "SYNC_NOW" }, {}, nextReply);
  await vi.waitFor(() => expect(nextReply).toHaveBeenCalledTimes(1));
  expect(mocks.sync).toHaveBeenCalledTimes(2);
});
