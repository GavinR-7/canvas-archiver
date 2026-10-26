import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SNAPSHOT } from "@/src/lib/messages";
import { normalizeCourse, normalizePlannerItem } from "@/src/canvas/normalize";
import { taskWindow, tasksInWindow } from "@/src/lib/task-window";
import Popup from "@/entrypoints/popup/App";
import Upcoming from "@/entrypoints/upcoming/App";
const state = vi.hoisted(() => ({ snapshot: {} as unknown, now: new Date("2026-10-25T12:00:00Z") }));
vi.mock("@/src/ui/useSnapshot", () => ({ useSnapshot: () => ({ snapshot: state.snapshot, loading: false, refreshing: false, refresh: () => {} }) }));
vi.mock("@/src/ui/useNow", () => ({ useNow: () => state.now }));

describe("popup Upcoming count", () => {
  it.each(["2026-10-25T12:00:00Z", "2026-03-01T12:00:00Z"])("matches the rendered fourteen-day page across DST from %s", (iso) => {
    state.now = new Date(iso);
    const window = taskWindow(state.now, 14);
    const course = normalizeCourse({ id: 1, name: "Fixture", course_code: "CS 1" });
    const tasks = [window.from - 1, window.from, window.to, window.to + 1].map((at, i) =>
      normalizePlannerItem({
        course_id: 1, plannable_type: "assignment", plannable_id: i + 1, plannable_date: new Date(at).toISOString(),
        plannable: { id: i + 1, title: "Deadline " + i, due_at: new Date(at).toISOString() },
      }, new Map([[1, course]]))!);
    state.snapshot = { ...EMPTY_SNAPSHOT, courses: [course], tasks };
    const popup = renderToStaticMarkup(createElement(Popup)).replace(/<[^>]+>/g, "");
    const upcoming = renderToStaticMarkup(createElement(Upcoming));
    expect(popup).toContain("Upcoming — next 14 days (" + tasksInWindow(tasks, window).length + ")");
    expect(upcoming).toContain("Deadline 1");
    expect(upcoming).toContain("Deadline 2");
    expect(upcoming).not.toContain("Deadline 0");
    expect(upcoming).not.toContain("Deadline 3");
  });
});
