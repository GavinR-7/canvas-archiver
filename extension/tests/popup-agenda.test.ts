import { describe, expect, it } from "vitest";
import { popupAgenda, POPUP_ITEM_LIMIT } from "@/src/lib/popup-agenda";
import type { Task, TaskSubmission } from "@/src/types/canvas";

/** Local-time constructor. Month is 1-based, unlike Date. */
const local = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

const iso = (date: Date) => date.toISOString();

const NOW = local(2026, 9, 25, 14, 0); // Fri 25 Sep, 2pm

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "assignment:1",
    source: "canvas",
    canvasId: 1,
    kind: "assignment",
    title: "Lab 3",
    htmlUrl: "https://canvas.cornell.edu/courses/1/assignments/1",
    courseId: 1,
    courseName: "Embedded Systems",
    courseCode: "ECE 3140",
    dueAt: iso(local(2026, 9, 25, 23, 59)),
    unlockAt: null,
    lockAt: null,
    allDay: false,
    pointsPossible: 100,
    submissionTypes: ["online_upload"],
    lockedForUser: false,
    submission: null,
    ...overrides,
  };
}

function submission(overrides: Partial<TaskSubmission> = {}): TaskSubmission {
  return {
    workflowState: "unsubmitted",
    submittedAt: null,
    gradedAt: null,
    attempt: null,
    score: null,
    grade: null,
    late: false,
    missing: false,
    excused: false,
    ...overrides,
  };
}

describe("popupAgenda", () => {
  it("keeps today through six days ahead and drops the day after that", () => {
    const today = task({ id: "today", title: "Today", dueAt: iso(local(2026, 9, 25, 23, 59)) });
    const sixth = task({ id: "sixth", title: "Sixth", dueAt: iso(local(2026, 10, 1, 9, 0)) });
    const seventh = task({ id: "seventh", title: "Seventh", dueAt: iso(local(2026, 10, 2, 9, 0)) });

    const agenda = popupAgenda([seventh, sixth, today], NOW);

    expect(agenda.items.map((item) => item.id)).toEqual(["today", "sixth"]);
    expect(agenda.hidden).toBe(0);
  });

  it("keeps overdue work and undated missing items, and puts the missing ones first", () => {
    const later = task({ id: "later", title: "Problem set", dueAt: iso(local(2026, 9, 26, 9, 0)) });
    const overdue = task({ id: "overdue", title: "Reading", dueAt: iso(local(2026, 9, 24, 23, 59)) });
    const missing = task({
      id: "missing",
      title: "Quiz 0",
      dueAt: null,
      submission: submission({ missing: true }),
    });

    const agenda = popupAgenda([later, missing, overdue], NOW);

    expect(agenda.items.map((item) => item.id)).toEqual(["missing", "overdue", "later"]);
  });

  it("caps the list and counts what is left in the window", () => {
    const items = Array.from({ length: POPUP_ITEM_LIMIT + 2 }, (_, index) =>
      task({
        id: `t${index}`,
        title: `Item ${index}`,
        dueAt: iso(local(2026, 9, 25, 15 + index, 0)),
      }),
    );

    const agenda = popupAgenda(items, NOW);

    expect(agenda.items).toHaveLength(POPUP_ITEM_LIMIT);
    expect(agenda.hidden).toBe(2);
    expect(agenda.items[0]?.id).toBe("t0");
  });

  it("ignores undated tasks that are not missing, and ignores an unreadable due date", () => {
    const note = task({ id: "note", title: "No date", dueAt: null });
    const broken = task({ id: "broken", title: "Broken", dueAt: "not-a-date" });
    const real = task({ id: "real", title: "Real" });

    expect(popupAgenda([note, broken, real], NOW).items.map((item) => item.id)).toEqual(["real"]);
  });

  it("still shows work that is already submitted, in due-date order", () => {
    const submitted = task({
      id: "submitted",
      title: "Problem Set 5",
      dueAt: iso(local(2026, 9, 25, 18, 0)),
      submission: submission({ workflowState: "submitted", submittedAt: iso(NOW) }),
    });
    const open = task({
      id: "open",
      title: "Lab 3",
      dueAt: iso(local(2026, 9, 25, 23, 59)),
    });

    expect(popupAgenda([open, submitted], NOW).items.map((item) => item.id)).toEqual([
      "submitted",
      "open",
    ]);
  });

  it("returns an empty agenda when nothing falls in the window", () => {
    const far = task({ id: "far", dueAt: iso(local(2026, 10, 20, 9, 0)) });
    expect(popupAgenda([far], NOW)).toEqual({ items: [], hidden: 0 });
  });
});
