import type { Task } from "@/src/types/canvas";

/** Explicit evidence from a reader; an empty task list alone proves nothing. */
export interface TaskRead {
  tasks: Task[];
  complete: boolean;
  /** Course ids whose cached deadlines must survive a partial syllabus read. */
  unavailableCourseIds: number[];
  error: unknown;
}
