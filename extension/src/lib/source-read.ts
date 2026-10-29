import type { Task } from "@/src/types/canvas";

/** Explicit evidence from a reader; an empty task list alone proves nothing. */
export interface TaskRead {
  tasks: Task[];
  complete: boolean;
  /** Course ids whose cached deadlines must survive a partial syllabus read. */
  unavailableCourseIds: number[];
  error: unknown;
}

/** A recognizable collection accompanied by an API error is not a successful read. */
export function hasApiError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (raw["error"] !== undefined && raw["error"] !== null) ||
    (raw["errors"] !== undefined && raw["errors"] !== null && (!Array.isArray(raw["errors"]) || raw["errors"].length > 0)) ||
    raw["success"] === false || raw["status"] === "error" || raw["status"] === "failed";
}
