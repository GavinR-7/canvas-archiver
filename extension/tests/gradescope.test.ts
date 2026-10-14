import { describe, expect, it } from "vitest";
import { currentCourses } from "@/src/gradescope/api";
import { parseAssignments, parseCourses, parseGradescopeTime } from "@/src/gradescope/parse";
import { taskStatus } from "@/src/lib/task-status";
import { ACCOUNT_PAGE, COURSE_PAGE } from "./fixtures/gradescope-markup";

describe("parseGradescopeTime", () => {
  it("converts a local time with offset to UTC", () => {
    expect(parseGradescopeTime("2026-09-15 23:59:00 -0400")).toBe("2026-09-16T03:59:00Z");
    expect(parseGradescopeTime("2026-11-02 18:00:00 -0500")).toBe("2026-11-02T23:00:00Z");
  });

  it("accepts a colon in the offset and a missing seconds field", () => {
    expect(parseGradescopeTime("2026-09-15 23:59 -04:00")).toBe("2026-09-16T03:59:00Z");
  });

  it("returns null for junk and absence", () => {
    expect(parseGradescopeTime("Sep 15")).toBeNull();
    expect(parseGradescopeTime(null)).toBeNull();
    expect(parseGradescopeTime("")).toBeNull();
  });
});

describe("parseCourses", () => {
  const courses = parseCourses(ACCOUNT_PAGE);

  it("reads id, names and the term heading above each course", () => {
    expect(courses).toHaveLength(3);
    expect(courses[0]).toMatchObject({
      id: 900001,
      shortName: "CS 3700",
      name: "Networks & Operating Systems",
      termLabel: "Fall 2026",
      termCode: "FA26",
    });
    expect(courses[2]).toMatchObject({ id: 800001, termCode: "SP26" });
  });

  it("returns nothing for a signed-out landing page", () => {
    expect(parseCourses("<html><a href='/login'>Log In</a></html>")).toEqual([]);
  });
});

describe("currentCourses", () => {
  const courses = parseCourses(ACCOUNT_PAGE);

  it("keeps only the current calendar term", () => {
    const ids = currentCourses(courses, new Date("2026-10-14T12:00:00")).map((c) => c.id);
    expect(ids).toEqual([900001, 900002]);
  });

  it("falls back to the newest listed term between terms", () => {
    // January: calendar says WI27, Gradescope still lists Fall 2026 as newest.
    const ids = currentCourses(courses, new Date("2027-01-05T12:00:00")).map((c) => c.id);
    expect(ids).toEqual([900001, 900002]);
  });
});

describe("parseAssignments", () => {
  const [course] = parseCourses(ACCOUNT_PAGE);
  const tasks = parseAssignments(COURSE_PAGE, course!);

  it("finds submitted-link rows and not-yet-submitted button rows, skipping others", () => {
    expect(tasks.map((t) => t.id)).toEqual([
      "gradescope:5550001",
      "gradescope:5550002",
      "gradescope:5550003",
    ]);
  });

  it("decodes entities in titles and labels the course", () => {
    expect(tasks[0]).toMatchObject({
      title: "Project 1 & Setup",
      source: "gradescope",
      kind: "assignment",
      courseId: 900001,
      courseCode: "CS 3700",
    });
  });

  it("builds an absolute Gradescope URL for both row shapes", () => {
    expect(tasks[0]?.htmlUrl).toBe(
      "https://www.gradescope.com/courses/900001/assignments/5550001/submissions/77001",
    );
    expect(tasks[1]?.htmlUrl).toBe(
      "https://www.gradescope.com/courses/900001/assignments/5550002",
    );
  });

  it("reads release, due and late-due dates", () => {
    expect(tasks[1]).toMatchObject({
      unlockAt: "2026-10-01T04:00:00Z",
      dueAt: "2026-10-21T03:59:00Z",
      lockAt: "2026-10-23T03:59:00Z",
    });
    // No late date: lock falls back to the due date.
    expect(tasks[2]?.lockAt).toBe(tasks[2]?.dueAt);
  });

  it("maps score, submitted and no-submission states", () => {
    expect(tasks[0]?.submission).toMatchObject({ workflowState: "graded", score: 92 });
    expect(tasks[0]?.pointsPossible).toBe(100);
    expect(tasks[1]?.submission?.workflowState).toBe("unsubmitted");
    expect(tasks[2]?.submission?.workflowState).toBe("submitted");
  });

  it("feeds the shared status logic: unsubmitted past due is overdue", () => {
    expect(taskStatus(tasks[1]!, new Date("2026-10-19T12:00:00Z"))).toBe("due-soon");
    expect(taskStatus(tasks[1]!, new Date("2026-10-25T12:00:00Z"))).toBe("overdue");
    expect(taskStatus(tasks[2]!, new Date("2026-11-10T12:00:00Z"))).toBe("submitted");
  });

  it("returns no tasks, rather than throwing, for an unrecognised page", () => {
    expect(parseAssignments("<html><body>nothing here</body></html>", course!)).toEqual([]);
  });
});
