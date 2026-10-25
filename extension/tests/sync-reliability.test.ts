import { afterEach, describe, expect, it, vi } from "vitest";
import { putFile, validate, type SyncSettings } from "@/src/sync/github";
import { syncDue } from "@/src/sync/run";
import { EMPTY_SNAPSHOT, type Snapshot } from "@/src/lib/messages";

const settings: SyncSettings = { enabled: true, repo: "owner/repo", path: "due.json", token: "test-token" };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const snapshot: Snapshot = { ...EMPTY_SNAPSHOT, fetchedAt: "2026-10-25T12:00:00Z", tasks: [{
  id: "canvas:1", source: "canvas", canvasId: 1, courseId: 1, courseName: "Course", courseCode: "CS 1",
  title: "Homework", kind: "assignment", dueAt: "2026-10-26T12:00:00Z", htmlUrl: "https://canvas.cornell.edu/x",
  allDay: false, unlockAt: null, lockAt: null, pointsPossible: null, submissionTypes: [], lockedForUser: false, submission: null,
}] };
const classes = [{ id: "lecture", course: "CS 1", title: "Lecture", days: ["mon" as const], start: "10:00", end: "11:00", location: "" }];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("GitHub request reliability", () => {
  it("refuses paths that alias schedule.json or contain empty path segments", () => {
    for (const path of ["schedule.json", "notes/schedule.json", "notes/", "notes//due.json", "./due.json"]) {
      expect(validate({ ...settings, path })).not.toBeNull();
    }
    expect(validate({ ...settings, path: "notes/due.json" })).toBeNull();
  });
  it.each(["fetch", "body"])("bounds a never-settling %s and aborts without leaking credentials", async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      if (stage === "fetch") return new Promise<Response>(() => {});
      return { ok: true, json: () => new Promise(() => {}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = putFile(settings, "new", () => false, "update", doFetch);
    await vi.advanceTimersByTimeAsync(15_001);
    const outcome = await result;
    expect(outcome).toMatchObject({ status: "failed", message: expect.stringMatching(/timed out/i) });
    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(settings.token);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
  it("refuses an unexpected contents response instead of writing without a SHA", async () => {
    const doFetch = vi.fn(async () => reply(200, { type: "dir" })) as unknown as typeof fetch;
    expect(await putFile(settings, "new", () => false, "update", doFetch)).toMatchObject({ status: "failed" });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
  it("uses the fresh SHA after a conflict and never follows redirects with the token", async () => {
    let reads = 0;
    const writes: RequestInit[] = [];
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      if (init?.method !== "PUT") return reply(200, { sha: ++reads === 1 ? "old" : "fresh", content: btoa("old") });
      writes.push(init);
      return reply(writes.length === 1 ? 409 : 200);
    }) as unknown as typeof fetch;
    expect(await putFile(settings, "new", () => false, "update", doFetch)).toEqual({ status: "updated", created: false });
    expect(writes.map((w) => JSON.parse(w.body as string).sha)).toEqual(["old", "fresh"]);
  });
  it("finishes without another write if a competing writer already uploaded the same content", async () => {
    let reads = 0;
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
      ? reply(409) : reply(200, { sha: "sha", content: btoa(++reads === 1 ? "old" : "new") })) as unknown as typeof fetch;
    expect(await putFile(settings, "new", (old) => old === "new", "update", doFetch)).toEqual({ status: "unchanged" });
    expect(doFetch).toHaveBeenCalledTimes(3);
  });
});

describe("combined deadline and schedule status", () => {
  it("marks a schedule upload failure as failed even after due.json succeeded", async () => {
    const set = vi.fn(async () => {});
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    const doFetch = vi.fn(async (url: unknown, init?: RequestInit) => String(url).endsWith("schedule.json")
      ? reply(403) : reply(init?.method === "PUT" ? 201 : 404)) as unknown as typeof fetch;
    expect(await syncDue(snapshot, settings, new Date("2026-10-25T12:00:00Z"), doFetch, classes)).toMatchObject({ status: "failed" });
    expect(set).toHaveBeenLastCalledWith({ "sync.status": expect.objectContaining({ ok: false, message: expect.stringMatching(/Schedule not sent/) }) });
  });
});
