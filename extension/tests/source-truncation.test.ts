// No source reader mocks: synthetic HTTP -> actual readers -> background -> syncDue.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";
import { normalizeCourse, normalizePlannerItem } from "@/src/canvas/normalize";
import { getAll } from "@/src/canvas/client";
import { buildDueFile } from "@/src/sync/due";
vi.mock("@/src/feed/settings", () => ({ loadFeed: async () => ({ enabled: false }), minutesUntilHour: () => 1 }));
const now = new Date("2026-10-25T12:00:00Z");
const course = normalizeCourse({ id: 1, name: "Fixture", course_code: "CS 1234" });
const task = normalizePlannerItem({ course_id: 1, plannable_type: "assignment", plannable_id: 1,
  plannable_date: "2026-10-26T12:00:00Z", plannable: { id: 1, title: "Remote deadline", due_at: "2026-10-26T12:00:00Z" } },
  new Map([[1, course]]))!;
const account = '<div class="courseList"><div class="courseList--term">Fall 2026</div><a class="courseBox" href="/courses/1"><h3 class="courseBox--shortname">CS 1234</h3></a></div>';
const emptyTable = '<table id="assignments-student-table"><tbody></tbody></table>';
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Rate-Limit-Remaining": "700" } });
beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
type Probe = { source: "ed" | "gradescope" | "canvas"; path: string; payload: unknown; courses?: boolean; cached?: boolean; link?: string; paged?: "planner" | "courses"; endsAt?: number; nonempty?: boolean };

async function run(probe?: Probe) {
  const cached = { ...task, id: probe?.source + ":cached", source: probe?.source ?? "ed" };
  const initial = buildDueFile([cached], now);
  let remote = initial;
  const data: Record<string, unknown> = {
    "consent.v1": { version: 1, acceptedAt: now.toISOString() },
    "sync.settings": { enabled: true, repo: "fixture/private", path: "due.json", token: "SYNTHETIC_TOKEN" },
    "snapshot.v2": probe?.cached ? { ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString(), tasks: [cached] } : EMPTY_SNAPSHOT,
  };
  let listener!: (message: { type: string }, sender: unknown, reply: (value: Snapshot) => void) => boolean;
  let pages = 0;
  const puts: string[] = [];
  const requested: string[] = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("defineBackground", (setup: () => void) => setup());
  vi.stubGlobal("chrome", {
    alarms: { get: async () => ({}), clear: async () => {}, onAlarm: { addListener: vi.fn() } },
    runtime: { onInstalled: { addListener: vi.fn() }, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: { onChanged: { addListener: vi.fn() }, local: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (items: Record<string, unknown>) => { Object.assign(data, items); },
    } },
  });
  vi.stubGlobal("fetch", vi.fn(async (value: unknown, init?: RequestInit) => {
    const url = new URL(String(value)); requested.push(url.href);
    if (url.origin === "https://api.github.com") {
      if (init?.method === "PUT") { puts.push(url.pathname); remote = JSON.parse(atob(JSON.parse(init.body as string).content)); return json({}); }
      return json({ sha: "existing", content: btoa(JSON.stringify(remote)) });
    }
    expect(init?.method).toBe("GET"); expect(init?.credentials).toBe("include");
    const source = url.hostname.includes("edstem") ? "ed" : url.hostname.includes("gradescope") ? "gradescope" : "canvas";
    if (probe?.paged && source === "canvas" && url.pathname.endsWith(probe.paged === "courses" ? "/courses" : "/planner/items")) {
      pages++;
      const payload = probe.paged === "courses" ? probe.nonempty ? [{ id: 1, name: "Fixture", course_code: "CS 1234" }] : []
        : probe.nonempty ? [{ course_id: 1, plannable_type: "assignment", plannable_id: 100 + pages,
          plannable_date: "2026-10-26T12:00:00Z", plannable: { id: 100 + pages, title: "WorkPage" + pages, due_at: "2026-10-26T12:00:00Z" } }] : [];
      const response = json(payload);
      if (!probe.endsAt || pages < probe.endsAt) response.headers.set("Link", '<' + url.origin + url.pathname + '?page=' + (pages + 1) + '>; rel="next"');
      return response;
    }
    if (probe?.source === source && probe.path === url.pathname) {
      const response = source === "gradescope" ? new Response(String(probe.payload)) : json(probe.payload);
      if (probe.link) response.headers.set("Link", probe.link);
      return response;
    }
    if (source === "ed") return json(url.pathname === "/api/user" ? { courses: probe?.source === "ed" && probe.courses ? [{ id: 9, code: "CS 1234" }] : [] } : { threads: [] });
    if (source === "gradescope") return new Response(url.pathname === "/account" ? probe?.source === "gradescope" && probe.courses ? account : '<div class="courseList"></div>' : emptyTable);
    expect(url.origin).toBe("https://canvas.cornell.edu");
    if (url.pathname.endsWith("/users/self")) return json({ id: 1, name: "Fixture" });
    if (url.pathname.endsWith("/courses")) return json([{ id: 1, name: "Fixture", course_code: "CS 1234" }]);
    if (url.pathname.endsWith("/planner/items")) return json([]);
    if (url.pathname.endsWith("/courses/1")) return json({ syllabus_body: "" });
    // The integrated syllabus-file reader also lists files; this fixture has none.
    if (/\/courses\/\d+\/files$/.test(url.pathname)) return json([]);
    throw new Error("Unexpected synthetic URL");
  }));
  await import("@/entrypoints/background");
  const snapshot = await new Promise<Snapshot>((resolve) => listener({ type: "SYNC_NOW" }, {}, resolve));
  return { snapshot, initial, remote, puts, data, requested, cached, pages };
}

const posts = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, type: "post", title: "Discussion", content: "No deadline" }));
const threadProbe = (payload: unknown, cached = false): Probe => ({ source: "ed", path: "/api/courses/9/threads", courses: true, payload, cached });

it.each([50, 51])("does not certify an Ed page of %i rows as complete", async (count) => {
  const result = await run(threadProbe({ threads: posts(count) }));
  expect(result.requested.some((url) => new URL(url).searchParams.get("limit") === "50")).toBe(true);
  expect(result.snapshot.sourceCompleteness?.ed).toBe(false);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
});
it.each([
  { has_more: true }, { hasMore: true }, { next: "/another-page" }, { next_page: 2 },
  { nextPage: 2 }, { total: 1 }, { total_count: 1 }, { totalCount: 1 },
  { pagination: { has_more: true } }, { pagination: { next: "cursor" } },
])("does not certify a known-truncated unsaturated Ed page: %j", async (metadata) => {
  const result = await run(threadProbe({ threads: [], ...metadata }));
  expect(result.snapshot.sourceCompleteness?.ed).toBe(false);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
});
it("keeps cached Ed rows and newly parsed rows from a saturated page locally", async () => {
  const rows = posts(50);
  rows[0] = { id: 1, type: "announcement", title: "New exam", content: "<p>Prelim: November 10, 2026 at 7pm.</p>" };
  const result = await run(threadProbe({ threads: rows }, true));
  expect(result.snapshot.tasks).toContainEqual(result.cached);
  expect(result.snapshot.tasks.some((task) => task.source === "ed" && task.id !== result.cached.id)).toBe(true);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
});
it.each([0, 49])("retains healthy unsaturated Ed success for %i recognized rows", async (count) => {
  const result = await run(threadProbe({ threads: posts(count), has_more: false, next: null, total: count }));
  expect(result.snapshot.sourceCompleteness?.ed).toBe(true);
  expect(result.puts).toHaveLength(1);
  expect(result.remote.items).toEqual([]);
});
for (const paged of ["planner", "courses"] as const) {
  it.each([false, true])("preserves remote/cache when " + paged + " reaches 25 pages with next pending (nonempty=%s)", async (nonempty) => {
    const result = await run({ source: "canvas", path: "/unused", payload: null, paged, nonempty, cached: true });
    expect(result.pages).toBe(25);
    expect(result.snapshot.sourceCompleteness?.canvas).toBe(false);
    expect(result.snapshot.tasks).toContainEqual(result.cached);
    expect(result.puts).toEqual([]);
    expect(result.remote).toEqual(result.initial);
  });
}
it.each([2, 25])("allows normally terminated Canvas pagination at page %i", async (endsAt) => {
  const result = await run({ source: "canvas", path: "/unused", payload: null, paged: "planner", endsAt });
  expect(result.pages).toBe(endsAt);
  expect(result.snapshot.sourceCompleteness?.canvas).toBe(true);
  expect(result.puts).toHaveLength(1);
  expect(result.remote.items).toEqual([]);
});

it("refuses configured maxPages=1 while a valid next link remains", async () => {
  const doFetch = vi.fn(async () => {
    const response = json([{ id: 1 }]);
    response.headers.set("Link", '<https://canvas.cornell.edu/api/v1/courses?page=2>; rel="next"');
    return response;
  });
  vi.stubGlobal("fetch", doFetch);
  await expect(getAll("/courses", {}, { maxPages: 1 })).rejects.toThrow(/page|incomplete/i);
  expect(doFetch).toHaveBeenCalledTimes(1);
});
it("accepts configured maxPages=1 when that page terminates", async () => {
  const doFetch = vi.fn(async () => json([{ id: 1 }]));
  vi.stubGlobal("fetch", doFetch);
  expect(await getAll("/courses", {}, { maxPages: 1 })).toEqual([{ id: 1 }]);
  expect(doFetch).toHaveBeenCalledTimes(1);
});

it("refuses Ed's explicit next-page Link even with a short recognized collection", async () => {
  const result = await run({ ...threadProbe({ threads: [] }, true), link: '<https://us.edstem.org/api/courses/9/threads?page=2>; rel="next"' });
  expect(result.snapshot.sourceCompleteness?.ed).toBe(false);
  expect(result.snapshot.tasks).toContainEqual(result.cached);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
});
it("accepts an Ed previous-page Link without a next page", async () => {
  const result = await run({ ...threadProbe({ threads: [] }), link: '<https://us.edstem.org/api/courses/9/threads?page=1>; rel="prev"' });
  expect(result.snapshot.sourceCompleteness?.ed).toBe(true);
  expect(result.puts).toHaveLength(1);
});
