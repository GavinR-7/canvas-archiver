// No source reader mocks: synthetic HTTP -> actual readers -> background -> syncDue.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";
import { normalizeCourse, normalizePlannerItem } from "@/src/canvas/normalize";
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
type Probe = { source: "ed" | "gradescope" | "canvas"; path: string; payload: unknown; courses?: boolean; cached?: boolean };

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
    if (probe?.source === source && probe.path === url.pathname) {
      return source === "gradescope" ? new Response(String(probe.payload)) : json(probe.payload);
    }
    if (source === "ed") return json(url.pathname === "/api/user" ? { courses: probe?.source === "ed" && probe.courses ? [{ id: 9, code: "CS 1234" }] : [] } : { threads: [] });
    if (source === "gradescope") return new Response(url.pathname === "/account" ? probe?.source === "gradescope" && probe.courses ? account : '<div class="courseList"></div>' : emptyTable);
    expect(url.origin).toBe("https://canvas.cornell.edu");
    if (url.pathname.endsWith("/users/self")) return json({ id: 1, name: "Fixture" });
    if (url.pathname.endsWith("/courses")) return json([{ id: 1, name: "Fixture", course_code: "CS 1234" }]);
    if (url.pathname.endsWith("/planner/items")) return json([]);
    if (url.pathname.endsWith("/courses/1")) return json({ syllabus_body: "" });
    throw new Error("Unexpected synthetic URL");
  }));
  await import("@/entrypoints/background");
  const snapshot = await new Promise<Snapshot>((resolve) => listener({ type: "SYNC_NOW" }, {}, resolve));
  return { snapshot, initial, remote, puts, data, requested, cached };
}

const bad: Probe[] = [
  ...[{}, null, [], { courses: null }, { courses: {} }, { courses: [{}] }, { courses: [{ id: 9 }] }, { courses: [], error: "denied" }, { courses: [], success: false }].map((payload): Probe => ({ source: "ed", path: "/api/user", payload })),
  ...[{}, null, [], { threads: null }, { threads: {} }, { threads: [{}] }, { threads: [], errors: ["denied"] },
    { threads: [{ id: 1, type: "announcement", title: "Exam", document: {} }] }].map((payload): Probe => ({ source: "ed", path: "/api/courses/9/threads", payload, courses: true })),
  ...['<html>Unexpected account</html>', '<div class="courseList"><a href="/courses/1">Changed course layout</a></div>'].map((payload): Probe => ({ source: "gradescope", path: "/account", payload })),
  ...['<html>Unexpected course</html>', '<table><tbody></tbody></table>',
    '<table id="assignments-student-table"><tbody></tbody></table><a href="/courses/1/assignments/5">Changed layout</a>',
    '<table id="assignments-student-table"><tbody><tr><td>Changed assignment row</td></tr></tbody></table>',
    '<table id="assignments-student-table"><tbody><tr><th><a href="/courses/1/assignments/5">Exam</a></th><td><time class="submissionTimeChart--dueDate" datetime="invalid">Due</time></td></tr></tbody></table>'].map((payload): Probe => ({ source: "gradescope", path: "/courses/1", payload, courses: true })),
  ...[{}, { items: {} }, [{}], { items: [], error: "denied" }, [{ plannable_type: "assignment", plannable_id: 1, plannable_date: "2026-10-26T12:00:00Z", plannable: { id: 1, title: "Bad due", due_at: "invalid" } }]].map((payload): Probe => ({ source: "canvas", path: "/api/v1/planner/items", payload })),
  ...[{}, [{}]].map((payload): Probe => ({ source: "canvas", path: "/api/v1/courses", payload })),
];
it.each(bad.map((probe, i) => ({ ...probe, label: i })))("preserves remote rows for unknown $source collection/markup #$label", async (probe) => {
  const result = await run(probe);
  expect(result.requested.some((url) => new URL(url).pathname === probe.path)).toBe(true);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
  expect(result.snapshot.sourceCompleteness?.[probe.source]).toBe(false);
});
it.each(["ed", "gradescope"] as const)("retains cached %s rows after unrecognized data", async (source) => {
  const result = await run({ source, path: source === "ed" ? "/api/user" : "/courses/1", payload: source === "ed" ? {} : "<html>Changed</html>", courses: true, cached: true });
  expect(result.snapshot.tasks).toContainEqual(result.cached);
  expect(result.puts).toEqual([]);
  expect(result.remote).toEqual(result.initial);
});
it.each([undefined, "ed", "gradescope"] as const)("permits recognized empty results with actual readers (%s course)", async (source) => {
  const result = await run(source === "ed" ? { source, path: "/api/courses/9/threads", payload: { threads: [] }, courses: true }
    : source === "gradescope" ? { source, path: "/courses/1", payload: emptyTable, courses: true } : undefined);
  expect(result.snapshot.sourceCompleteness).toEqual({ canvas: true, syllabus: true, ed: true, gradescope: true });
  expect(result.puts).toHaveLength(1);
  expect(result.remote.items).toEqual([]);
});
