import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasTabIsActive, isCanvasUrl } from "@/src/lib/canvas-tab";
import { describeRun, whatChanged } from "@/src/files/summary";
import { planCourse, type CanvasDocument } from "@/src/files/plan";
import type { ItemOutcome } from "@/src/files/runner";

describe("popup: is a Canvas tab active (T-535)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (query: () => Promise<Array<{ url?: string }>>) => vi.stubGlobal("chrome", { tabs: { query } });

  it("recognises only the Canvas origin", () => {
    expect(isCanvasUrl("https://canvas.cornell.edu/courses/7")).toBe(true);
    expect(isCanvasUrl("https://canvas.cornell.edu.evil.example/")).toBe(false);
    expect(isCanvasUrl("https://www.gradescope.com/")).toBe(false);
    expect(isCanvasUrl(undefined)).toBe(false);
    expect(isCanvasUrl("not a url")).toBe(false);
  });
  it("is true on a Canvas tab and false elsewhere, with no tab address, or if the query throws", async () => {
    stub(async () => [{ url: "https://canvas.cornell.edu/" }]);
    expect(await canvasTabIsActive()).toBe(true);
    stub(async () => [{ url: "https://example.com/" }]);
    expect(await canvasTabIsActive()).toBe(false);
    stub(async () => [{}]);
    expect(await canvasTabIsActive()).toBe(false);
    stub(async () => { throw new Error("no tabs"); });
    expect(await canvasTabIsActive()).toBe(false);
  });
});

const saved = (role: ItemOutcome extends infer O ? (O extends { role?: infer R } ? R : never) : never, n: number): ItemOutcome[] =>
  Array.from({ length: n }, (_, i) => ({ source: `${role}:${i}`, path: ["a"], status: "saved" as const, decision: "new" as const, role }));

describe("Done line (T-535)", () => {
  it("says what the new items were, in a fixed order, and counts unchanged as skipped", () => {
    const outcomes = [...saved("image", 9), ...saved("attachment", 31), ...saved("handout", 1)];
    expect(whatChanged({ outcomes })).toBe("31 attachments, 9 images, 1 handout");
    expect(describeRun({ saved: 41, unchanged: 98, failed: 0, outcomes, cancelled: false })).toBe(
      "41 new (31 attachments, 9 images, 1 handout), 98 unchanged skipped, 0 failed",
    );
  });
  it("has no parenthesis when nothing was saved, and notes an early stop", () => {
    expect(describeRun({ saved: 0, unchanged: 7, failed: 1, outcomes: [], cancelled: true })).toBe("0 new, 7 unchanged skipped, 1 failed (stopped early)");
  });
  it("the plan tags files, pages, attachments, images and handouts", () => {
    const f = (id: number) => ({ id, displayName: `f${id}.pdf`, filename: `f${id}.pdf`, size: 1, updatedAt: "t", url: "https://canvas.cornell.edu/files/x", locked: false, folderId: null, contentType: "application/pdf" });
    const doc: CanvasDocument = { kind: "page", key: "p", title: "P", html: "", modifiedAt: null, htmlUrl: null, attachmentIds: [2, 3], imageOnlyIds: [3] };
    const plan = planCourse({ id: 7, name: "C", courseCode: "CS 3700" }, {
      modules: [], files: [f(1), f(2), f(3)] as never, folders: [], documents: [doc],
      external: [{ source: "gradescope:file/1/a", system: "gradescope", filename: "h.pdf", url: "https://www.gradescope.com/h.pdf" }],
    });
    const roles = Object.fromEntries(plan.items.map((i) => [i.source, i.role]));
    expect(roles).toMatchObject({ "canvas:file/1": "file", "canvas:file/2": "attachment", "canvas:file/3": "image", "gradescope:file/1/a": "handout", "canvas:page/p": "page" });
  });
});
