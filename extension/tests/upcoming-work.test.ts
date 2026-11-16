import { describe, expect, it } from "vitest";
import { upcomingWork } from "@/src/lib/upcoming-work";
import type { Task, TaskSubmission } from "@/src/types/canvas";

const NOW = new Date("2026-11-16T17:00:00Z");

function task(id: string, dueAt: string | null, fields: Partial<Task> = {}): Task {
  return {
    id, dueAt, title: id, courseId: 1, courseCode: "ECE 3140", courseName: "Embedded Systems",
    kind: "assignment", source: "canvas", canvasId: 1, htmlUrl: "https://canvas.cornell.edu/courses/1/assignments/1",
    unlockAt: null, lockAt: null, allDay: false, pointsPossible: null, submissionTypes: [],
    lockedForUser: false, submission: null,
    ...fields,
  };
}

function submission(fields: Partial<TaskSubmission>): TaskSubmission {
  return {
    workflowState: "unsubmitted", submittedAt: null, gradedAt: null, attempt: null,
    score: null, grade: null, late: false, missing: false, excused: false,
    ...fields,
  };
}

describe("Upcoming work", () => {
  it("shows overdue and authoritative missing work once, including undated items", () => {
    const tasks = [
      task("missing without date", null, { submission: submission({ missing: true }) }),
      task("due tomorrow", "2026-11-17T23:00:00Z"),
      task("future marked missing", "2026-11-18T23:00:00Z", { submission: submission({ missing: true }) }),
      task("overdue", "2026-11-12T23:00:00Z"),
      task("past exam", "2026-11-12T01:00:00Z", { kind: "exam" }),
      task("Final exam", "2026-11-12T02:00:00Z", { source: "gradescope" }),
      task("after window", "2026-12-15T00:00:00Z"),
      task("no date", null),
    ];
    const result = upcomingWork(tasks, NOW, 14, null, false);
    expect(result.attention.map((t) => t.id)).toEqual(["overdue", "future marked missing", "missing without date"]);
    expect(result.upcoming.map((t) => t.id)).toEqual(["due tomorrow"]);
  });

  it("filters by course and hides completed work until requested", () => {
    const tasks = [
      task("other course", "2026-11-17T00:00:00Z", { courseId: 2 }),
      task("submitted", "2026-11-19T00:00:00Z", { submission: submission({ workflowState: "submitted" }) }),
      task("graded", "2026-11-20T00:00:00Z", { submission: submission({ workflowState: "graded" }) }),
      task("past submitted", "2026-11-14T00:00:00Z", { submission: submission({ workflowState: "submitted" }) }),
      task("selected course due", "2026-11-18T00:00:00Z"),
    ];

    expect(upcomingWork(tasks, NOW, 14, 1, false).upcoming.map((t) => t.id)).toEqual(["selected course due"]);
    const all = upcomingWork(tasks, NOW, 14, 1, true);
    expect(all.attention).toEqual([]);
    expect(all.upcoming.map((t) => t.id)).toEqual(["selected course due", "submitted", "graded"]);
  });
});
