import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";
import type { TaskRead } from "@/src/lib/source-read";
import type { Task } from "@/src/types/canvas";
import { normalizeCourse, normalizePlannerItem } from "@/src/canvas/normalize";
import { buildDueFile } from "@/src/sync/due";
import { syncDue } from "@/src/sync/run";

const mocks = vi.hoisted(() => {
  const read = async (): Promise<TaskRead> => ({ tasks: [], complete: true, unavailableCourseIds: [], error: null });
  return {
    canvas: vi.fn(read), gradescope: vi.fn(read), syllabus: vi.fn(read), ed: vi.fn(read),
    files: vi.fn(async (): Promise<{ tasks: Task[]; unreadable: number }> => ({ tasks: [], unreadable: 0 })),
    previous: null as Snapshot | null, data: {} as Record<string, unknown>,
  };
});
vi.mock("@/src/canvas/api", () => ({
  fetchUser: async () => ({ id: 1 }), fetchActiveCourses: async () => [course], fetchUpcomingTasks: mocks.canvas,
}));
vi.mock("@/src/gradescope/api", () => ({ fetchGradescopeTasks: mocks.gradescope }));
vi.mock("@/src/dates/syllabus", () => ({ fetchSyllabusTasks: mocks.syllabus }));
vi.mock("@/src/dates/syllabus-files", () => ({ syllabusFileTasks: mocks.files }));
vi.mock("@/src/ed/api", () => ({ fetchEdTasks: mocks.ed }));
vi.mock("@/src/consent/consent", () => ({ hasConsent: async () => true }));
vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }), minutesUntilHour: () => 1 }));
vi.mock("@/src/lib/storage", () => ({ loadSnapshot: async () => mocks.previous ?? EMPTY_SNAPSHOT, saveSnapshot: async () => {} }));

const now = new Date("2026-10-25T12:00:00Z");
const course = normalizeCourse({ id: 1, name: "Fixture", course_code: "CS 1234" });
function task(id: number, days: number, exam = false, source: Task["source"] = "canvas"): Task {
  const due = new Date(now.getTime() + days * 86_400_000).toISOString();
  return {
    ...normalizePlannerItem({ course_id: 1, plannable_id: id, plannable_type: "assignment",
      plannable_date: due, plannable: { id, title: exam ? "Prelim " + id : "Homework " + id, due_at: due } },
    new Map([[1, course]]))!, source,
  };
}
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const empty = { tasks: [], complete: true, unavailableCourseIds: [], error: null };
  for (const mock of [mocks.canvas, mocks.gradescope, mocks.syllabus, mocks.ed]) mock.mockResolvedValue(empty);
  mocks.files.mockResolvedValue({ tasks: [], unreadable: 0 });
  mocks.previous = null; mocks.data = {};
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function refresh() {
  let listener!: (message: { type: string }, sender: unknown, reply: (snapshot: Snapshot) => void) => boolean;
  vi.stubGlobal("defineBackground", (setup: () => void) => setup());
  vi.stubGlobal("chrome", {
    alarms: { get: async () => ({}), clear: async () => {}, onAlarm: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: {
      onChanged: { addListener: vi.fn() },
      local: { get: async (key: string) => ({ [key]: mocks.data[key] }), set: async (value: Record<string, unknown>) => { Object.assign(mocks.data, value); } },
    },
  });
  await import("@/entrypoints/background");
  return new Promise<Snapshot>((resolve) => listener({ type: "REFRESH" }, {}, resolve));
}
async function expectNoUpload(snapshot: Snapshot) {
  const doFetch = vi.fn() as unknown as typeof fetch;
  expect(await syncDue(snapshot, { enabled: true, repo: "fixture/private", path: "due.json", token: "SYNTHETIC_TOKEN" }, now, doFetch)).toMatchObject({ status: "failed" });
  expect(doFetch).not.toHaveBeenCalled();
}

it("keeps the due.json window while retaining exams beyond fourteen and sixty days", async () => {
  const rows = [task(1, -8), task(2, -7), task(3, 20), task(4, 60), task(5, 61), task(6, 120, true)];
  mocks.canvas.mockResolvedValue({ tasks: rows, complete: true, unavailableCourseIds: [], error: null });
  const snapshot = await refresh();
  expect(snapshot.tasks.map((t) => t.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[3]!.id]);
  expect(snapshot.exams).toEqual([rows[5]]);
  expect(buildDueFile(snapshot.tasks, now).items).toHaveLength(3);
  expect(mocks.canvas).toHaveBeenCalledWith([course], 240, now, 7);
  expect(mocks.files).toHaveBeenCalledWith([course], 240, expect.any(Object), now, 7);
});

it("keeps cached far-future exams and fresh partial rows without authorizing replacement", async () => {
  const cached = task(7, 100, true, "gradescope");
  const fresh = task(8, 20, true, "gradescope");
  mocks.previous = { ...EMPTY_SNAPSHOT, exams: [cached] };
  mocks.gradescope.mockResolvedValue({ tasks: [fresh], complete: false, unavailableCourseIds: [1], error: new Error("unreadable") });
  const snapshot = await refresh();
  expect(snapshot.exams).toEqual(expect.arrayContaining([cached, fresh]));
  expect(snapshot.tasks).toContainEqual(fresh);
  expect(snapshot.tasks).not.toContainEqual(cached);
  expect(snapshot.sourceCompleteness?.gradescope).toBe(false);
  await expectNoUpload(snapshot);
});

it("keeps cached syllabus exams and refuses replacement when a syllabus file is unreadable", async () => {
  const cached = task(9, 20, true, "syllabus");
  mocks.previous = { ...EMPTY_SNAPSHOT, exams: [cached] };
  mocks.files.mockResolvedValue({ tasks: [], unreadable: 1 });
  const snapshot = await refresh();
  expect(snapshot.tasks).toContainEqual(cached);
  expect(snapshot.exams).toContainEqual(cached);
  expect(snapshot.sourceCompleteness?.syllabus).toBe(false);
  await expectNoUpload(snapshot);
});

it("adds local manual exams to the normal deadline window and the separate exam list", async () => {
  mocks.data["settings.manual-exams.v1"] = { "1": [
    { date: "2026-11-05", time: "19:30", label: "Entered near exam" },
    { date: "2027-02-01", time: "19:30", label: "Entered far exam" },
  ] };
  const snapshot = await refresh();
  expect(snapshot.tasks.map((t) => t.title)).toEqual(["Entered near exam"]);
  expect(snapshot.exams?.map((t) => t.title)).toEqual(["Entered near exam", "Entered far exam"]);
  expect(buildDueFile(snapshot.tasks, now).items).toHaveLength(1);
  expect(snapshot.sourceCompleteness).toEqual({ canvas: true, gradescope: true, syllabus: true, ed: true });
});
