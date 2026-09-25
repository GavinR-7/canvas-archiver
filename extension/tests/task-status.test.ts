import { describe, expect, it } from "vitest";
import { taskStatus, byDueDate } from "@/src/lib/task-status";
import type { Task, TaskSubmission } from "@/src/types/canvas";

const NOW = new Date("2026-03-01T12:00:00Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "assignment:1",
    canvasId: 1,
    kind: "assignment",
    title: "Lab 3",
    htmlUrl: "https://canvas.cornell.edu/courses/1/assignments/1",
    courseId: 1,
    courseName: "Embedded Systems",
    courseCode: "ECE 3140",
    dueAt: "2026-03-05T04:59:00Z",
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

describe("taskStatus", () => {
  it("reports upcoming for a future due date with no submission", () => {
    expect(taskStatus(task(), NOW)).toBe("upcoming");
  });

  it("reports due-soon inside 48 hours", () => {
    expect(taskStatus(task({ dueAt: "2026-03-02T12:00:00Z" }), NOW)).toBe("due-soon");
  });

  it("reports overdue once the due date has passed", () => {
    expect(taskStatus(task({ dueAt: "2026-02-28T12:00:00Z" }), NOW)).toBe("overdue");
  });

  it("does NOT report overdue for work already handed in", () => {
    // The point of checking submission before the clock: a submitted task
    // whose deadline has passed is done, not late.
    const done = task({
      dueAt: "2026-02-28T12:00:00Z",
      submission: submission({ workflowState: "submitted", submittedAt: "2026-02-27T10:00:00Z" }),
    });
    expect(taskStatus(done, NOW)).toBe("submitted");
  });

  it("reports graded over submitted", () => {
    const graded = task({
      submission: submission({ workflowState: "graded", score: 94 }),
    });
    expect(taskStatus(graded, NOW)).toBe("graded");
  });

  it("treats excused as done rather than missing", () => {
    const excused = task({
      dueAt: "2026-02-28T12:00:00Z",
      submission: submission({ missing: true, excused: true }),
    });
    expect(taskStatus(excused, NOW)).toBe("graded");
  });

  it("honours Canvas's missing flag even before the due date", () => {
    // An instructor can mark something missing early; Canvas is authoritative.
    const missing = task({ submission: submission({ missing: true }) });
    expect(taskStatus(missing, NOW)).toBe("missing");
  });

  it("reports no-due-date rather than guessing", () => {
    expect(taskStatus(task({ dueAt: null }), NOW)).toBe("no-due-date");
    expect(taskStatus(task({ dueAt: "not-a-date" }), NOW)).toBe("no-due-date");
  });

  it("is derived from the clock, not stored", () => {
    const t = task({ dueAt: "2026-03-05T04:59:00Z" });
    expect(taskStatus(t, new Date("2026-03-01T12:00:00Z"))).toBe("upcoming");
    expect(taskStatus(t, new Date("2026-03-04T12:00:00Z"))).toBe("due-soon");
    expect(taskStatus(t, new Date("2026-03-06T12:00:00Z"))).toBe("overdue");
  });
});

describe("byDueDate", () => {
  it("sorts earliest first with undated last", () => {
    const sorted = [
      task({ id: "c", dueAt: null }),
      task({ id: "b", dueAt: "2026-03-05T00:00:00Z" }),
      task({ id: "a", dueAt: "2026-03-02T00:00:00Z" }),
    ].sort(byDueDate);

    expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});
