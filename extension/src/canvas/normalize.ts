/**
 * Canvas JSON → domain types.
 *
 * One boundary, converting the API's conditionally-shaped payloads into the
 * types in `src/types/canvas.ts`, so nothing downstream writes a defensive
 * lookup. Carried over from the CLI: **Canvas omits fields as readily as it
 * nulls them**, and both must collapse to the same thing.
 */

import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import type {
  CanvasUser,
  Course,
  CourseWorkflowState,
  EnrollmentState,
  Task,
  TaskKind,
  TaskSubmission,
} from "@/src/types/canvas";
import { resolveTerm } from "./terms";

/** Canvas sends `null` as readily as it omits a key. Treat both as absent. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Canvas returns relative `html_url`s on some endpoints and absolute on others. */
function absoluteUrl(value: unknown, origin = DEFAULT_CANVAS_ORIGIN): string {
  const raw = str(value);
  if (!raw) return origin;
  return raw.startsWith("http") ? raw : new URL(raw, origin).toString();
}

// --------------------------------------------------------------------------
// User
// --------------------------------------------------------------------------

export function normalizeUser(raw: Record<string, unknown>): CanvasUser {
  return {
    id: num(raw["id"]) ?? 0,
    name: str(raw["name"]) || str(raw["short_name"]) || "Canvas user",
    shortName: iso(raw["short_name"]),
    avatarUrl: iso(raw["avatar_url"]),
  };
}

// --------------------------------------------------------------------------
// Courses
// --------------------------------------------------------------------------

const ENROLLMENT_STATES = new Set<EnrollmentState>([
  "active", "completed", "invited", "pending",
]);

const WORKFLOW_STATES = new Set<CourseWorkflowState>([
  "available", "unpublished", "completed", "deleted",
]);

/** The current user's enrollment state on this course. */
function enrollmentState(raw: Record<string, unknown>): EnrollmentState {
  const enrollments = raw["enrollments"];
  if (!Array.isArray(enrollments)) return "unknown";

  for (const enrollment of enrollments) {
    const state = (enrollment as Record<string, unknown>)?.["enrollment_state"];
    if (typeof state === "string" && ENROLLMENT_STATES.has(state as EnrollmentState)) {
      return state as EnrollmentState;
    }
  }
  return "unknown";
}

export function normalizeCourse(raw: Record<string, unknown>): Course {
  const id = num(raw["id"]) ?? 0;
  const courseCode = str(raw["course_code"]);
  const workflow = str(raw["workflow_state"]);

  return {
    id,
    // A restricted course arrives with almost nothing populated, so the name
    // has to degrade twice before giving up.
    name: str(raw["name"]) || courseCode || `Course ${id}`,
    courseCode,
    term: resolveTerm(raw["term"] as never),
    enrollmentState: enrollmentState(raw),
    workflowState: WORKFLOW_STATES.has(workflow as CourseWorkflowState)
      ? (workflow as CourseWorkflowState)
      : "unknown",
    restricted: bool(raw["access_restricted_by_date"]),
    htmlUrl: absoluteUrl(`/courses/${id}`),
  };
}

// --------------------------------------------------------------------------
// Tasks
// --------------------------------------------------------------------------

/**
 * Canvas's `plannable_type` values, mapped onto our three task kinds.
 *
 * Everything else the planner can return — wiki pages, planner notes, calendar
 * events, assessment requests — is not a task and is dropped.
 */
const PLANNABLE_TO_KIND: Record<string, TaskKind> = {
  assignment: "assignment",
  quiz: "quiz",
  discussion_topic: "discussion",
};

/**
 * Build a `TaskSubmission` from a planner item's `submissions` field.
 *
 * Careful: Canvas sends `submissions: false` — the boolean, not an object —
 * for items that have no submission concept at all. That is genuinely
 * different from an unsubmitted assignment, which sends an object with every
 * flag false.
 */
function normalizeSubmission(raw: unknown): TaskSubmission | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const s = raw as Record<string, unknown>;
  const graded = bool(s["graded"]);
  const submitted = bool(s["submitted"]);

  return {
    workflowState: graded
      ? "graded"
      : bool(s["needs_grading"])
        ? "pending_review"
        : submitted
          ? "submitted"
          : "unsubmitted",
    submittedAt: iso(s["submitted_at"]),
    gradedAt: iso(s["graded_at"]),
    attempt: num(s["attempt"]),
    score: num(s["score"]),
    grade: iso(s["grade"]),
    late: bool(s["late"]),
    missing: bool(s["missing"]),
    excused: bool(s["excused"]),
  };
}

/**
 * Convert one planner item into a `Task`, or `null` if it is not one.
 *
 * `/api/v1/planner/items` is the right source for "what's coming up": it is
 * user-scoped, so one request covers every course, and it returns exactly the
 * things that carry a date. See `extension/ARCHITECTURE.md` §4.
 */
export function normalizePlannerItem(
  raw: Record<string, unknown>,
  courseLookup: Map<number, Course>,
): Task | null {
  const kind = PLANNABLE_TO_KIND[str(raw["plannable_type"])];
  if (!kind) return null;

  const plannable = (raw["plannable"] ?? {}) as Record<string, unknown>;
  const canvasId = num(raw["plannable_id"]) ?? num(plannable["id"]);
  if (!canvasId) return null;

  const courseId = num(raw["course_id"]) ?? 0;
  const course = courseLookup.get(courseId);

  // `plannable_date` is the planner's own notion of when this matters; for an
  // assignment it mirrors due_at, for an ungraded discussion it may be todo_date.
  const dueAt = iso(plannable["due_at"]) ?? iso(raw["plannable_date"]);

  const submissionTypes = Array.isArray(plannable["submission_types"])
    ? (plannable["submission_types"] as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : [];

  const task: Task = {
    id: `${kind}:${canvasId}`,
    canvasId,
    kind,
    title: str(plannable["title"]) || str(raw["plannable_type"]) || "Untitled",
    htmlUrl: absoluteUrl(raw["html_url"]),
    courseId,
    courseName: course?.name ?? "Unknown course",
    courseCode: course?.courseCode ?? "",
    dueAt,
    unlockAt: iso(plannable["unlock_at"]),
    lockAt: iso(plannable["lock_at"]),
    allDay: bool(plannable["all_day"]),
    pointsPossible: num(plannable["points_possible"]),
    submissionTypes,
    lockedForUser: bool(plannable["locked_for_user"]),
    submission: normalizeSubmission(raw["submissions"]),
  };

  if (kind === "quiz") {
    task.quiz = {
      questionCount: num(plannable["question_count"]),
      timeLimitMinutes: num(plannable["time_limit"]),
      allowedAttempts: num(plannable["allowed_attempts"]),
    };
  }
  if (kind === "discussion") {
    task.discussion = {
      postedAt: iso(plannable["posted_at"]),
      requireInitialPost: bool(plannable["require_initial_post"]),
    };
  }

  return task;
}
