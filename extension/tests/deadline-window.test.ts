import { afterEach, describe, expect, it, vi } from "vitest";
import { taskWindow, tasksInWindow } from "@/src/lib/task-window";
import { fetchUpcomingTasks } from "@/src/canvas/api";
import { normalizeCourse } from "@/src/canvas/normalize";
import { fetchGradescopeTasks } from "@/src/gradescope/api";
import { fetchSyllabusTasks } from "@/src/dates/syllabus";
import { fetchEdTasks } from "@/src/ed/api";
import { buildDueFile, sameContent, serialize } from "@/src/sync/due";
import { syncDue } from "@/src/sync/run";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";
import type { Task } from "@/src/types/canvas";
import { ACCOUNT_PAGE } from "./fixtures/gradescope-markup";

const client = vi.hoisted(() => ({ getAll: vi.fn(), getOne: vi.fn() }));
vi.mock("@/src/canvas/client", () => client);
const now = new Date("2026-10-25T12:00:00Z");
const course = normalizeCourse({ id: 1, name: "Networks", course_code: "CS 3700" });
const dates = [
  "2026-10-18T11:59:59.999Z", "2026-10-18T12:00:00.000Z", "2026-10-20T12:00:00Z",
  "2026-11-20T12:00:00Z", "2026-12-24T12:00:00.000Z", "2026-12-24T12:00:00.001Z",
];
const settings = { enabled: true, repo: "owner/repo", path: "due.json", token: "test-token" };
const task = (over: Partial<Task> = {}): Task => ({
  id: "canvas:1", source: "canvas", canvasId: 1, kind: "assignment", title: "Homework", htmlUrl: course.htmlUrl,
  courseId: 1, courseName: course.name, courseCode: course.courseCode, dueAt: dates[2]!, unlockAt: null, lockAt: null,
  allDay: false, pointsPossible: null, submissionTypes: [], lockedForUser: false, submission: null, ...over,
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("scheduler source windows", () => {
  it("asks Canvas for the full window and keeps both inclusive boundaries", async () => {
    client.getAll.mockResolvedValue(dates.map((dueAt, index) => ({
      course_id: 1, plannable_id: index + 1, plannable_type: "assignment", plannable_date: dueAt,
      plannable: { id: index + 1, title: "Work " + index, due_at: dueAt },
    })));
    const tasks = await fetchUpcomingTasks([course], 60, now, 7);
    expect(client.getAll).toHaveBeenCalledWith("/planner/items", {
      start_date: dates[1], end_date: dates[4],
    });
    expect(tasks.map((t) => t.dueAt)).toEqual(dates.slice(1, 5));
    const upcoming = await fetchUpcomingTasks([course], 14, now);
    expect(upcoming).toEqual([]);
  });
  it("includes recently overdue and far-future Gradescope assignments", async () => {
    const rows = dates.map((dueAt, index) => '<tr><th><a href="/courses/900001/assignments/' + (index + 1) +
      '/submissions/1">Work ' + index + '</a></th><td><time class="submissionTimeChart--dueDate" datetime="' +
      dueAt.replace(".000Z", "Z") + '">Due</time></td></tr>').join("");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
      url.endsWith("/account") ? ACCOUNT_PAGE : url.endsWith("/900001") ? "<table>" + rows + "</table>" : "<table></table>",
      { status: 200 },
    )));
    const tasks = await fetchGradescopeTasks(60, now, 7);
    expect(tasks.map((t) => t.id)).toContain("gradescope:3");
    expect(tasks.map((t) => t.id)).toContain("gradescope:4");
    expect(tasks.map((t) => t.id)).not.toContain("gradescope:1");
  });
  it("uses the same overdue window for syllabus and Ed candidates", async () => {
    const text = "<p>Prelim 1: October 20, 2026 at 7pm.</p><p>Final exam: December 15, 2026 at 7pm.</p>";
    client.getOne.mockResolvedValue({ syllabus_body: text });
    const syllabus = await fetchSyllabusTasks([course], 60, now, 7);
    expect(syllabus).toHaveLength(2);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/api/user")
      ? { courses: [{ id: 9, code: "CS 3700" }] }
      : { threads: [{ id: 1, type: "announcement", title: "", content: text }] }), {
      headers: { "Content-Type": "application/json" },
    })));
    const ed = await fetchEdTasks([course], 60, now, 7);
    expect(ed).toHaveLength(2);
    expect(ed.map((t) => t.dueAt)).toEqual(syllabus.map((t) => t.dueAt));
  });
});

describe("due.json contract", () => {
  it("keeps the Upcoming view at fourteen days even when the cache contains the full scheduler window", () => {
    const cache = [
      task({ id: "overdue", dueAt: "2026-10-24T12:00:00Z" }),
      task({ id: "now", dueAt: now.toISOString() }),
      task({ id: "edge", dueAt: "2026-11-08T12:00:00Z" }),
      task({ id: "later", dueAt: "2026-11-20T12:00:00Z" }),
    ];
    expect(tasksInWindow(cache, taskWindow(now, 14)).map((t) => t.id)).toEqual(["now", "edge"]);
    expect(taskWindow(now, 14).to - taskWindow(now, 14).from).toBe(14 * 86_400_000);
  });
  it("keeps healthy sources syncing when another source uses cached deadlines", async () => {
    vi.stubGlobal("chrome", { storage: { local: { set: vi.fn(async () => {}) } } });
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response("{}", { status: init?.method === "PUT" ? 201 : 404 })) as unknown as typeof fetch;
    expect(await syncDue({ ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString(), tasks: [task()],
      edError: { kind: "network", message: "offline" } }, settings, now, doFetch)).toMatchObject({ status: "updated" });
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
  it("keeps exact UTC boundaries across the DST change and drops invalid dates", () => {
    const file = buildDueFile([...dates, "invalid"].map((dueAt, i) => task({ id: String(i), dueAt })), now);
    expect(file.items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    expect(file.items.map((item) => item.dueDay)).toEqual(["2026-10-18", "2026-10-20", "2026-11-20", "2026-12-24"]);
  });
  it("normalizes equivalent instants before comparing or sorting exports", () => {
    const first = buildDueFile([task({ dueAt: "2026-10-26T03:59:00Z" })], now);
    const offset = buildDueFile([task({ dueAt: "2026-10-25T23:59:00-04:00" })], now);
    expect(serialize(first)).toBe(serialize(offset));
    expect(first.items[0]?.dueDay).toBe("2026-10-25");
    expect(sameContent(JSON.stringify({ ...first, timezone: "UTC" }), first)).toBe(false);
  });
  it("publishes an authoritative empty refresh so removed deadlines do not live forever", async () => {
    const set = vi.fn(async () => {});
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    let written = "";
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const { content } = JSON.parse(init.body as string);
        written = atob(content);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ sha: "old", content: btoa(serialize(buildDueFile([task()], now))) }));
    }) as unknown as typeof fetch;
    expect(await syncDue({ ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString() }, settings, now, doFetch)).toMatchObject({ status: "updated" });
    expect(JSON.parse(written).items).toEqual([]);
  });
  it.each(["error", "gradescopeError", "edError", "syllabusError"])("preserves remote deadlines when an empty export has a %s refresh error", async (key) => {
    vi.stubGlobal("chrome", { storage: { local: { set: vi.fn(async () => {}) } } });
    const doFetch = vi.fn() as unknown as typeof fetch;
    const snapshot = { ...EMPTY_SNAPSHOT, fetchedAt: now.toISOString(), tasks: [task({ dueAt: "2026-09-01T12:00:00Z" })], [key]: { kind: "network", message: "offline" } } as Snapshot;
    expect(await syncDue(snapshot, settings, now, doFetch)).toMatchObject({ status: "failed" });
    expect(doFetch).not.toHaveBeenCalled();
  });
  it("never publishes a snapshot that has not been fetched", async () => {
    vi.stubGlobal("chrome", { storage: { local: { set: vi.fn(async () => {}) } } });
    const doFetch = vi.fn() as unknown as typeof fetch;
    expect(await syncDue(EMPTY_SNAPSHOT, settings, now, doFetch)).toMatchObject({ status: "failed" });
    expect(doFetch).not.toHaveBeenCalled();
  });
});
