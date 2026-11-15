/**
 * Per-course opt-in for course chat.
 *
 * Course chat sends passages of a course's text to the AI provider the person
 * chose, with their own key. Some instructors restrict that for their course
 * and the extension cannot tell which, so the choice is made course by course
 * and starts off. The set holds the Canvas ids of the courses allowed.
 */

const KEY = "chat.allowedCourses";

export function isAllowed(allowed: readonly number[], courseId: number): boolean {
  return allowed.includes(courseId);
}

export function withCourse(allowed: readonly number[], courseId: number, on: boolean): number[] {
  const rest = allowed.filter((id) => id !== courseId);
  return on ? [...rest, courseId] : rest;
}

export async function loadAllowed(): Promise<number[]> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    return Array.isArray(stored) ? stored.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

export async function setCourseAllowed(courseId: number, on: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: withCourse(await loadAllowed(), courseId, on) });
}

export const CHAT_OPT_IN_TEXT =
  "Course text from this course will be sent to Anthropic, the AI provider, using your own API key. Some instructors restrict AI tools for their course; check this course's policy first.";
