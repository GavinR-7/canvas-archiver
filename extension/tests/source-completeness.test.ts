// Actual Canvas HTTP client + readers + background + sync runner; all services are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";
import { normalizeCourse, normalizePlannerItem } from "@/src/canvas/normalize";
import { buildDueFile } from "@/src/sync/due";
import { syncDue } from "@/src/sync/run";

vi.mock("@/src/gradescope/api", () => ({ fetchGradescopeTasks: async () => ({ tasks: [], complete: true, unavailableCourseIds: [], error: null }) }));
vi.mock("@/src/ed/api", () => ({ fetchEdTasks: async () => ({ tasks: [], complete: true, unavailableCourseIds: [], error: null }) }));
vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }), minutesUntilHour: () => 1 }));
const now = new Date("2026-10-25T12:00:00Z");
const complete = { canvas: true, gradescope: true, syllabus: true, ed: true };
const course = normalizeCourse({ id: 1, name: "Fixture", course_code: "CS 1234" });
const plannerItem = {
  course_id: 1, plannable_id: 1, plannable_type: "assignment", plannable_date: "2026-10-26T12:00:00Z",
  plannable: { id: 1, title: "Existing homework", due_at: "2026-10-26T12:00:00Z" },
};
const cachedTask = normalizePlannerItem(plannerItem, new Map([[1, course]]))!;
const syllabusTask = { ...cachedTask, id: "syllabus:2", source: "syllabus" as const, courseId: 2, courseCode: "ECE 2", title: "Cached prelim" };
const settings = { enabled: true, repo: "fixture/private", path: "due.json", token: "SYNTHETIC_TOKEN" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Rate-Limit-Remaining": "700" } });
beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function runSync(options: { source?: "planner" | "syllabus"; status?: number; cached?: boolean; partial?: boolean; syllabusShape?: "missing" | "restricted" } = {}) {
  const previous: Snapshot = options.cached ? {
    ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString(), courses: [course], tasks: [cachedTask, syllabusTask],
    sourceCompleteness: complete,
  } : EMPTY_SNAPSHOT;
  const data: Record<string, unknown> = { "sync.settings": settings, "snapshot.v2": previous, "consent.v1": { version: 1, acceptedAt: now.toISOString() } };
  const initialRemote = buildDueFile([cachedTask, syllabusTask], now);
  let remote = initialRemote;
  let listener!: (message: { type: string }, sender: unknown, reply: (snapshot: Snapshot) => void) => boolean;
  const puts: string[] = [];
  const requested: string[] = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("defineBackground", (setup: () => void) => setup());
  vi.stubGlobal("chrome", {
    alarms: { get: async () => ({}), clear: async () => {}, onAlarm: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: {
      onChanged: { addListener: vi.fn() },
      local: { get: async (key: string) => ({ [key]: data[key] }), set: async (items: Record<string, unknown>) => { Object.assign(data, items); } },
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value));
    requested.push(url.href);
    if (url.origin === "https://api.github.com") {
      if (init?.method === "PUT") {
        puts.push(url.pathname);
        remote = JSON.parse(atob(JSON.parse(init.body as string).content));
        return json({});
      }
      return json({ sha: "existing-sha", content: btoa(JSON.stringify(remote)) });
    }
    expect(url.origin).toBe("https://canvas.cornell.edu");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("include");
    if (url.pathname.endsWith("/users/self")) return json({ id: 1, name: "Fixture" });
    if (url.pathname.endsWith("/courses")) return json(options.partial ? [
      { id: 1, name: "Fixture", course_code: "CS 1234" }, { id: 2, name: "Fields", course_code: "ECE 2" },
    ] : [{ id: 1, name: "Fixture", course_code: "CS 1234", access_restricted_by_date: options.syllabusShape === "restricted" }]);
    if (url.pathname.endsWith("/planner/items")) return options.source === "planner" ? json({ message: "unavailable" }, options.status) : json([]);
    if (url.pathname.endsWith("/courses/2") || (url.pathname.endsWith("/courses/1") && options.source === "syllabus" && !options.partial)) {
      return json({ message: "unavailable" }, options.status);
    }
    if (url.pathname.endsWith("/courses/1") && options.syllabusShape === "missing") return json({ id: 1 });
    if (url.pathname.endsWith("/courses/1")) return json({ syllabus_body: options.partial ? "<p>Final exam: November 20, 2026 at 7pm.</p>" : "" });
    throw new Error("Unexpected synthetic request");
  }));
  await import("@/entrypoints/background");
  const snapshot = await new Promise<Snapshot>((resolve) => listener({ type: "SYNC_NOW" }, {}, resolve));
  return { snapshot, initialRemote, remote, puts, requested, data };
}

describe("actual reader to background/SYNC_NOW to remote export", () => {
  for (const source of ["planner", "syllabus"] as const) {
    it.each([403, 404])("preserves populated remote deadlines after " + source + " %i with no local cache", async (status) => {
      const result = await runSync({ source, status });
      expect(result.requested.some((url) => new URL(url).pathname.endsWith("/planner/items"))).toBe(true);
      if (source === "syllabus") expect(result.requested.some((url) => new URL(url).pathname.endsWith("/courses/1"))).toBe(true);
      expect(result.puts).toEqual([]);
      expect(result.remote).toEqual(result.initialRemote);
      expect(result.snapshot.sourceCompleteness?.[source === "planner" ? "canvas" : "syllabus"]).toBe(false);
      expect(result.data["sync.status"]).toMatchObject({ ok: false });
    });
  }
  it("retains cached Canvas deadlines and refuses a remote replacement after a planner denial", async () => {
    const result = await runSync({ source: "planner", status: 403, cached: true });
    expect(result.snapshot.tasks).toContainEqual(cachedTask);
    expect(result.puts).toEqual([]);
    expect(result.remote).toEqual(result.initialRemote);
  });
  it("keeps a denied course's cached syllabus dates while reading another course", async () => {
    const result = await runSync({ source: "syllabus", status: 404, cached: true, partial: true });
    expect(result.snapshot.tasks).toContainEqual(syllabusTask);
    expect(result.snapshot.tasks.some((task) => task.title.includes("Final"))).toBe(true);
    expect(result.snapshot.syllabusError).not.toBeNull();
    expect(result.puts).toEqual([]);
    expect(result.remote).toEqual(result.initialRemote);
  });
  it.each(["missing", "restricted"] as const)("does not authorize replacement from a %s syllabus", async (syllabusShape) => {
    const result = await runSync({ syllabusShape, cached: true });
    expect(result.snapshot.sourceCompleteness?.syllabus).toBe(false);
    expect(result.puts).toEqual([]);
    expect(result.remote).toEqual(result.initialRemote);
    if (syllabusShape === "restricted") expect(result.requested.some((url) => new URL(url).pathname.endsWith("/courses/1"))).toBe(false);
  });
  it("clears the populated destination only after affirmative successful empty reads", async () => {
    const result = await runSync();
    expect(result.snapshot.sourceCompleteness).toEqual(complete);
    expect(result.puts).toEqual(["/repos/fixture/private/contents/due.json"]);
    expect(result.remote.items).toEqual([]);
    expect(result.data["sync.status"]).toMatchObject({ ok: true });
  });
});

it.each([false, true])("does not infer completeness from a legacy snapshot with null error flags (nonempty=%s)", async (nonempty) => {
  vi.stubGlobal("chrome", { storage: { local: { set: vi.fn(async () => {}) } } });
  const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "PUT" ? json({}) : json({ sha: "old", content: btoa(JSON.stringify(buildDueFile([cachedTask], now))) })) as unknown as typeof fetch;
  expect(await syncDue({ ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString(), tasks: nonempty ? [cachedTask] : [] }, settings, now, doFetch)).toMatchObject({ status: "failed" });
  expect(doFetch).not.toHaveBeenCalled();
});
