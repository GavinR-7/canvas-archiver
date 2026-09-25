import { describe, expect, it } from "vitest";
import { normalizeCourse, normalizePlannerItem, normalizeUser } from "@/src/canvas/normalize";
import type { Course } from "@/src/types/canvas";

describe("normalizeCourse", () => {
  it("reads a fully populated course", () => {
    const course = normalizeCourse({
      id: 12345,
      name: "Embedded Systems",
      course_code: "ECE 3140",
      workflow_state: "available",
      term: { id: 9, name: "Fall 2025", start_at: "2025-08-25T04:00:00Z" },
      enrollments: [{ enrollment_state: "active", type: "student" }],
    });

    expect(course).toMatchObject({
      id: 12345,
      name: "Embedded Systems",
      courseCode: "ECE 3140",
      enrollmentState: "active",
      workflowState: "available",
      restricted: false,
    });
    expect(course.term.code).toBe("FA25");
  });

  it("survives a bare restricted course", () => {
    // Canvas omits nearly everything for these; it must not throw.
    const course = normalizeCourse({ id: 999, access_restricted_by_date: true });

    expect(course.restricted).toBe(true);
    expect(course.name).toBe("Course 999");
    expect(course.term.code).toBe("NOTERM");
    expect(course.enrollmentState).toBe("unknown");
  });

  it("treats explicit nulls as absent", () => {
    // Canvas sends `"name": null` as readily as it omits the key.
    const course = normalizeCourse({
      id: 7, course_code: "ECE 2300", name: null, term: null, enrollments: null,
    });
    expect(course.name).toBe("ECE 2300");
    expect(course.term.code).toBe("NOTERM");
  });
});

describe("normalizeUser", () => {
  it("falls back through name, short_name, then a placeholder", () => {
    expect(normalizeUser({ id: 1, name: "Gavin Reis" }).name).toBe("Gavin Reis");
    expect(normalizeUser({ id: 1, short_name: "Gavin" }).name).toBe("Gavin");
    expect(normalizeUser({ id: 1 }).name).toBe("Canvas user");
  });
});

describe("normalizePlannerItem", () => {
  const courses = new Map<number, Course>([
    [1, { id: 1, name: "Embedded Systems", courseCode: "ECE 3140" } as Course],
  ]);

  const assignment = {
    context_type: "Course",
    course_id: 1,
    plannable_id: 4821993,
    plannable_type: "assignment",
    plannable_date: "2026-02-18T04:59:00Z",
    html_url: "/courses/1/assignments/4821993",
    plannable: {
      id: 4821993,
      title: "Lab 3 — UART Driver",
      due_at: "2026-02-18T04:59:00Z",
      points_possible: 100,
      submission_types: ["online_upload"],
    },
    submissions: { submitted: false, excused: false, graded: false, late: false, missing: false },
  };

  it("converts an assignment and joins the course name", () => {
    const task = normalizePlannerItem(assignment, courses);

    expect(task).toMatchObject({
      id: "assignment:4821993",
      kind: "assignment",
      title: "Lab 3 — UART Driver",
      courseCode: "ECE 3140",
      dueAt: "2026-02-18T04:59:00Z",
      pointsPossible: 100,
    });
    expect(task?.submission?.workflowState).toBe("unsubmitted");
  });

  it("absolutises the relative html_url Canvas returns here", () => {
    expect(normalizePlannerItem(assignment, courses)?.htmlUrl).toBe(
      "https://canvas.cornell.edu/courses/1/assignments/4821993",
    );
  });

  it("handles `submissions: false`, which is not the same as unsubmitted", () => {
    // Canvas sends the boolean `false` for items with no submission concept.
    // Coercing that to an object would invent a submission that doesn't exist.
    const task = normalizePlannerItem({ ...assignment, submissions: false }, courses);
    expect(task?.submission).toBeNull();
  });

  it.each([
    ["quiz", "quiz"],
    ["discussion_topic", "discussion"],
  ])("maps plannable_type %s to kind %s", (plannableType, kind) => {
    const task = normalizePlannerItem(
      { ...assignment, plannable_type: plannableType }, courses,
    );
    expect(task?.kind).toBe(kind);
  });

  it.each(["wiki_page", "planner_note", "calendar_event", "assessment_request"])(
    "drops %s, which is not a task", (plannableType) => {
      expect(normalizePlannerItem({ ...assignment, plannable_type: plannableType }, courses))
        .toBeNull();
    },
  );

  it("falls back gracefully when the course is unknown", () => {
    const task = normalizePlannerItem(assignment, new Map());
    expect(task?.courseName).toBe("Unknown course");
    expect(task?.courseCode).toBe("");
  });

  it("attaches quiz-only fields only to quizzes", () => {
    const quiz = normalizePlannerItem(
      {
        ...assignment,
        plannable_type: "quiz",
        plannable: { ...assignment.plannable, question_count: 20, time_limit: 60 },
      },
      courses,
    );
    expect(quiz?.quiz).toEqual({ questionCount: 20, timeLimitMinutes: 60, allowedAttempts: null });
    expect(normalizePlannerItem(assignment, courses)?.quiz).toBeUndefined();
  });
});
