/**
 * Core domain types.
 *
 * These are the contract a future scheduler consumes, so they are defined
 * before the UI that displays them. Two rules carried over from the Python
 * reference implementation in `cli/`:
 *
 * 1. **Timestamps stay exactly as Canvas returned them** — ISO 8601, UTC, with
 *    the `Z` suffix. Conversion to local time happens at render, never at
 *    storage. Stored data outlives any one machine's timezone setting.
 * 2. **Canvas omits fields as readily as it nulls them.** Every optional field
 *    is `T | null` rather than `T | undefined`, and normalisation collapses
 *    both absence and `null` to `null`, so downstream code has one case.
 */

/** ISO 8601 timestamp in UTC, e.g. `"2026-02-18T04:59:00Z"`. */
export type IsoTimestamp = string;

// --------------------------------------------------------------------------
// Courses
// --------------------------------------------------------------------------

/**
 * A Canvas enrollment term.
 *
 * `code` is the short form (`FA25`, `SP26`) derived from `name`, falling back
 * to the month of `startAt`. The derivation rules are ported from
 * `cli/src/canvas_archiver/terms.py`, which handles the several spellings
 * Canvas produces for one term (`"Fall 2025"`, `"2025FA"`, `"FA25"`).
 */
export interface Term {
  id: number | null;
  name: string | null;
  startAt: IsoTimestamp | null;
  endAt: IsoTimestamp | null;
  /** Short code such as `"FA25"`, or `"NOTERM"` when it cannot be derived. */
  code: string;
}

/** The current user's enrollment state on a course. */
export type EnrollmentState =
  | "active"
  | "completed"
  | "invited"
  | "pending"
  | "unknown";

/** Canvas's own publication state for a course. */
export type CourseWorkflowState =
  | "available"
  | "unpublished"
  | "completed"
  | "deleted"
  | "unknown";

export interface Course {
  id: number;
  /** Full name, e.g. `"Embedded Systems"`. Falls back to `courseCode`. */
  name: string;
  /** Short code, e.g. `"ECE 3140"`. Empty string when Canvas withholds it. */
  courseCode: string;
  term: Term;
  enrollmentState: EnrollmentState;
  workflowState: CourseWorkflowState;
  /**
   * True when Canvas returned the course with `access_restricted_by_date`.
   * Such courses arrive with almost no other fields populated; they are kept
   * and flagged rather than dropped, so the UI can explain an absence instead
   * of silently producing one.
   */
  restricted: boolean;
  /** Absolute URL of the course in the Canvas web UI. */
  htmlUrl: string;
}

// --------------------------------------------------------------------------
// Tasks
// --------------------------------------------------------------------------

/**
 * What kind of Canvas object a task came from.
 *
 * These three are the things that carry a due date. Pages, files and
 * announcements never do, so they are not tasks.
 */
export type TaskKind = "assignment" | "quiz" | "discussion";

/** Canvas's `workflow_state` for the current user's submission. */
export type SubmissionWorkflowState =
  | "submitted"
  | "unsubmitted"
  | "graded"
  | "pending_review"
  | "unknown";

/**
 * The current user's submission, from `include[]=submission`.
 *
 * `null` for tasks with no submission concept, and for assignments never
 * attempted. Note that Canvas reports a submission object with
 * `workflow_state: "unsubmitted"` rather than omitting it, so absence and
 * "not yet done" are genuinely different states.
 */
export interface TaskSubmission {
  workflowState: SubmissionWorkflowState;
  submittedAt: IsoTimestamp | null;
  gradedAt: IsoTimestamp | null;
  attempt: number | null;
  score: number | null;
  grade: string | null;
  late: boolean;
  missing: boolean;
  excused: boolean;
}

/**
 * Derived, display-ready status.
 *
 * Computed rather than stored raw, because the answer depends on the current
 * time (an unsubmitted task is only "overdue" once its due date has passed).
 * Recomputed on read; never persisted.
 */
export type TaskStatus =
  | "graded"
  | "submitted"
  | "missing"
  | "overdue"
  | "due-soon"
  | "upcoming"
  | "locked"
  | "no-due-date";

/**
 * Anything with a due date, normalised across the three Canvas endpoints that
 * produce one.
 *
 * A future scheduler consumes this directly, which is why the scheduling
 * fields are first-class rather than buried in a rendered description.
 */
export interface Task {
  /** Stable composite key, e.g. `"assignment:4821993"`. Unique across kinds. */
  id: string;
  canvasId: number;
  kind: TaskKind;
  title: string;
  /** Absolute URL of the task in the Canvas web UI. */
  htmlUrl: string;

  courseId: number;
  /** Denormalised so a task list renders without joining against courses. */
  courseName: string;
  courseCode: string;

  /** When it is due. `null` for undated tasks, which Canvas permits. */
  dueAt: IsoTimestamp | null;
  /** When it becomes available. */
  unlockAt: IsoTimestamp | null;
  /** After which submission is refused. Often equals or trails `dueAt`. */
  lockAt: IsoTimestamp | null;
  /** True when Canvas treats the due date as a whole day, with no time. */
  allDay: boolean;

  pointsPossible: number | null;
  /** e.g. `["online_upload"]`. Empty for quizzes and discussions. */
  submissionTypes: string[];
  /** True when Canvas says the task is currently locked for this user. */
  lockedForUser: boolean;

  submission: TaskSubmission | null;

  /** Fields that exist for only one kind, kept rather than discarded. */
  quiz?: {
    questionCount: number | null;
    timeLimitMinutes: number | null;
    allowedAttempts: number | null;
  };
  discussion?: {
    postedAt: IsoTimestamp | null;
    requireInitialPost: boolean;
  };
}

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/** The signed-in Canvas user, from `GET /api/v1/users/self`. */
export interface CanvasUser {
  id: number;
  name: string;
  shortName: string | null;
  avatarUrl: string | null;
}
