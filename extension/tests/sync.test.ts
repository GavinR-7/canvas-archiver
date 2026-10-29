import { describe, expect, it, vi } from "vitest";
import { buildDueFile, sameContent, serialize } from "@/src/sync/due";
import { putFile, validate, type SyncSettings } from "@/src/sync/github";
import type { Task } from "@/src/types/canvas";

const now = new Date("2026-10-15T12:00:00Z");
const task = (over: Partial<Task>): Task => ({
  id: "canvas:1", source: "canvas", canvasId: 1, kind: "assignment", title: "Lab 3", htmlUrl: "https://canvas.cornell.edu/x",
  courseId: 7, courseName: "Embedded", courseCode: "ECE 3140", dueAt: "2026-10-17T03:59:00Z", unlockAt: null, lockAt: null,
  allDay: false, pointsPossible: 10, submissionTypes: [], lockedForUser: false, submission: null, ...over,
});

describe("buildDueFile", () => {
  it("lists dated work in the window with the Eastern day, flags done and unconfirmed", () => {
    const file = buildDueFile(
      [
        task({}),
        task({ id: "g:1", source: "gradescope", title: "HW", submission: { workflowState: "submitted", submittedAt: null, gradedAt: null, attempt: 1, score: 9, grade: "9", late: false, missing: false, excused: false } }),
        task({ id: "s:1", source: "syllabus", kind: "exam", title: "Prelim 1", unconfirmed: true, dueAt: "2026-10-20T23:30:00Z" }),
        task({ id: "n", dueAt: null }),
        task({ id: "old", dueAt: "2026-09-01T00:00:00Z" }),
        task({ id: "far", dueAt: "2027-06-01T00:00:00Z" }),
      ],
      now,
    );
    expect(file.items.map((i) => i.id)).toEqual(["canvas:1", "g:1", "s:1"]);
    expect(file.items[0]).toMatchObject({ dueDay: "2026-10-16", done: false, unconfirmed: false, course: "ECE 3140" });
    expect(file.items[1]?.done).toBe(true);
    expect(file.items[2]).toMatchObject({ kind: "exam", unconfirmed: true });
    expect(JSON.stringify(file)).not.toMatch(/"score"|"grade"/i);
  });
  it("keeps recently overdue work so the plan can flag it", () => {
    expect(buildDueFile([task({ dueAt: "2026-10-12T03:59:00Z" })], now).items).toHaveLength(1);
  });
  it("sameContent ignores generatedAt only", () => {
    const a = buildDueFile([task({})], now);
    const later = buildDueFile([task({})], new Date("2026-10-15T14:00:00Z"));
    expect(sameContent(serialize(a), later)).toBe(true);
    expect(sameContent(serialize(a), buildDueFile([task({ title: "Lab 4" })], now))).toBe(false);
    expect(sameContent("not json", a)).toBe(false);
  });
});

const settings: SyncSettings = { enabled: true, repo: "GavinR-7/gavin-data", path: "due.json", token: "ghp_SECRET" };

const reply = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const b64 = (s: string) => btoa(s);

describe("validate", () => {
  it("rejects bad repo, traversal paths and a missing token", () => {
    expect(validate(settings)).toBeNull();
    expect(validate({ ...settings, repo: "nope" })).toMatch(/owner\/name/);
    expect(validate({ ...settings, path: "../x" })).toMatch(/relative/);
    expect(validate({ ...settings, path: "/abs" })).toMatch(/relative/);
    expect(validate({ ...settings, token: "" })).toMatch(/token/i);
  });
});

describe("putFile", () => {
  it("creates the file when absent", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return init?.method === "PUT" ? reply(201) : reply(404);
    }) as unknown as typeof fetch;
    expect(await putFile(settings, "hello é", () => false, "msg", doFetch)).toEqual({ status: "updated", created: true });
    const put = calls[1];
    expect(put?.url).toBe("https://api.github.com/repos/GavinR-7/gavin-data/contents/due.json");
    const body = JSON.parse(put?.init?.body as string);
    expect(body.sha).toBeUndefined();
    expect(new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)))).toBe("hello é");
    expect((put?.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_SECRET");
  });
  it("updates with the existing sha, and skips the write when content is the same", async () => {
    const put = vi.fn();
    const doFetch = (async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") { put(init); return reply(200); }
      return reply(200, { sha: "abc", content: b64("same") });
    }) as unknown as typeof fetch;
    expect(await putFile(settings, "new", () => false, "m", doFetch)).toEqual({ status: "updated", created: false });
    expect(JSON.parse(put.mock.calls[0]![0].body).sha).toBe("abc");
    put.mockClear();
    expect(await putFile(settings, "same", (e) => e === "same", "m", doFetch)).toEqual({ status: "unchanged" });
    expect(put).not.toHaveBeenCalled();
  });
  it("retries once on a stale sha, then gives up with a plain message", async () => {
    let puts = 0;
    const doFetch = (async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") { puts++; return reply(409); }
      return reply(200, { sha: "abc", content: b64("x") });
    }) as unknown as typeof fetch;
    const out = await putFile(settings, "y", () => false, "m", doFetch);
    expect(puts).toBe(2);
    expect(out).toMatchObject({ status: "failed" });
  });
  it("explains auth failures and never echoes the token", async () => {
    const doFetch = (async () => reply(401)) as unknown as typeof fetch;
    const out = await putFile(settings, "y", () => false, "m", doFetch);
    expect(out).toMatchObject({ status: "failed", message: expect.stringMatching(/token/i) });
    const thrower = (async () => { throw new TypeError("fetch failed with Authorization: Bearer ghp_SECRET"); }) as unknown as typeof fetch;
    const failed = await putFile(settings, "y", () => false, "m", thrower);
    expect(JSON.stringify(failed)).not.toContain("ghp_SECRET");
  });
  it("does not call the network with invalid settings", async () => {
    const doFetch = vi.fn() as unknown as typeof fetch;
    expect(await putFile({ ...settings, repo: "x" }, "y", () => false, "m", doFetch)).toMatchObject({ status: "failed" });
    expect(doFetch).not.toHaveBeenCalled();
  });
});
