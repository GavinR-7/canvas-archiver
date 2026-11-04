import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowed, loadAllowed, setCourseAllowed, withCourse } from "@/src/chat/optin";

function stubStorage(initial?: unknown) {
  const data: Record<string, unknown> = initial === undefined ? {} : { "chat.allowedCourses": initial };
  vi.stubGlobal("chrome", {
    storage: { local: { get: async (k: string) => (k in data ? { [k]: data[k] } : {}), set: async (o: Record<string, unknown>) => void Object.assign(data, o) } },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("per-course chat opt-in", () => {
  it("starts off for every course", async () => {
    stubStorage();
    expect(isAllowed(await loadAllowed(), 7)).toBe(false);
  });
  it("allows one course without allowing the others, and can turn it off again", async () => {
    stubStorage();
    await setCourseAllowed(7, true);
    await setCourseAllowed(8, true);
    let allowed = await loadAllowed();
    expect([isAllowed(allowed, 7), isAllowed(allowed, 8), isAllowed(allowed, 9)]).toEqual([true, true, false]);
    await setCourseAllowed(7, false);
    allowed = await loadAllowed();
    expect([isAllowed(allowed, 7), isAllowed(allowed, 8)]).toEqual([false, true]);
  });
  it("does not duplicate and ignores junk in storage", async () => {
    expect(withCourse([1, 2], 2, true).filter((id) => id === 2)).toHaveLength(1);
    stubStorage(["a", 3, null, 4.5]);
    expect(await loadAllowed()).toEqual([3]);
  });
});
