/**
 * Gradescope HTML → domain types.
 *
 * Gradescope has no student API, so this reads the pages a signed-in student
 * sees: the account page (course list) and each course page (assignment
 * table). Pure functions over strings, so they are unit-tested without a
 * browser.
 *
 * **No DOM.** This runs in the MV3 service worker, which has no `DOMParser`.
 * The parser is therefore a small set of regexes keyed on Gradescope's CSS
 * class names (`courseBox`, `submissionStatus--text`,
 * `submissionTimeChart--dueDate`). Those are presentation hooks, not a
 * contract, so every extractor degrades to "skip this row" rather than
 * throwing, and a page that yields no rows is reported to the caller as
 * suspicious instead of as an empty week.
 */

import { termCodeFromName } from "@/src/canvas/terms";
import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import type { IsoTimestamp, Task, TaskSubmission } from "@/src/types/canvas";

export interface GradescopeCourse {
  id: number;
  /** e.g. `"CS 3700"`. */
  shortName: string;
  name: string;
  /** Heading the course sits under on the account page, e.g. `"Fall 2026"`. */
  termLabel: string | null;
  /** `"FA26"`, or `null` when the heading is not a recognisable term. */
  termCode: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML fragment: tags dropped, entities decoded, trimmed. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Inner HTML of the first element whose class list contains `className`. */
function innerOfClass(html: string, className: string): string | null {
  const open = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "i").exec(html);
  if (!open) return null;
  const tag = open[1];
  const start = open.index + open[0].length;
  const close = html.indexOf(`</${tag}>`, start);
  return close === -1 ? null : html.slice(start, close);
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
  return match?.[1] !== undefined ? decodeEntities(match[1]) : null;
}

// --------------------------------------------------------------------------
// Timestamps
// --------------------------------------------------------------------------

/**
 * Gradescope writes `datetime="2026-09-10 23:59:00 -0400"` — a local time with
 * its offset, which `Date` will not parse as written. Converted to UTC with a
 * `Z` suffix, matching how Canvas timestamps are stored.
 */
export function parseGradescopeTime(raw: string | null | undefined): IsoTimestamp | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
    raw.trim(),
  );
  if (!match?.[1] || !match[2]) return null;

  const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
  let offset = match[3] ?? "Z";
  if (offset !== "Z" && !offset.includes(":")) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;

  const parsed = new Date(`${match[1]}T${time}${offset}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --------------------------------------------------------------------------
// Course list (account page)
// --------------------------------------------------------------------------

/**
 * Courses on the account page, each tagged with the term heading above it.
 *
 * Instructor and student sections share this markup; instructor courses are
 * harmless here because their course pages have no student assignment table
 * and so contribute no rows.
 */
export function parseCourses(html: string): GradescopeCourse[] {
  const courses: GradescopeCourse[] = [];
  let termLabel: string | null = null;

  const token =
    /<div[^>]*class="[^"]*courseList--term[^"]*"[^>]*>([\s\S]*?)<\/div>|<a\b([^>]*class="[^"]*\bcourseBox\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) {
      termLabel = textOf(match[1]) || null;
      continue;
    }
    const href = attr(match[2] ?? "", "href");
    const id = Number(/\/courses\/(\d+)/.exec(href ?? "")?.[1]);
    if (!id) continue;

    const body = match[3] ?? "";
    const shortName = textOf(innerOfClass(body, "courseBox--shortname") ?? "");
    const name = textOf(innerOfClass(body, "courseBox--name") ?? "") || shortName;

    courses.push({
      id,
      shortName: shortName || name || `Course ${id}`,
      name: name || shortName || `Course ${id}`,
      termLabel,
      termCode: termCodeFromName(termLabel),
    });
  }

  return courses;
}

// --------------------------------------------------------------------------
// Assignment table (course page)
// --------------------------------------------------------------------------

function parseSubmission(statusHtml: string): { submission: TaskSubmission; pointsPossible: number | null } {
  const scoreText = textOf(innerOfClass(statusHtml, "submissionStatus--score") ?? "");
  const statusText = textOf(innerOfClass(statusHtml, "submissionStatus--text") ?? "");

  const score = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(scoreText);
  const graded = score !== null;
  const submitted = graded || /submitted|resubmitted/i.test(statusText);

  return {
    pointsPossible: score?.[2] ? Number(score[2]) : null,
    submission: {
      workflowState: graded ? "graded" : submitted ? "submitted" : "unsubmitted",
      // Gradescope shows when work is due, not when it was handed in.
      submittedAt: null,
      gradedAt: null,
      attempt: null,
      score: score?.[1] ? Number(score[1]) : null,
      grade: graded ? scoreText : null,
      late: /late/i.test(statusText),
      // "No Submission" past the due date is not Canvas's `missing` flag, so
      // it stays false and the UI's overdue logic covers it from the clock.
      missing: false,
      excused: false,
    },
  };
}

/**
 * Assignments from one course page.
 *
 * A row looks like (reconstructed from the live markup; see the test fixture):
 *
 * ```html
 * <tr>
 *   <th class="table--primaryLink"><a href="/courses/1/assignments/2/submissions/3">HW 1</a></th>
 *   <!-- or, when nothing is submitted: -->
 *   <th class="table--primaryLink"><button class="js-submitAssignment" data-assignment-id="2">HW 1</button></th>
 *   <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
 *   <td><time class="submissionTimeChart--releaseDate" datetime="2026-09-01 00:00:00 -0400">…</time>
 *       <time class="submissionTimeChart--dueDate" datetime="2026-09-10 23:59:00 -0400">…</time>
 *       <time class="submissionTimeChart--dueDate" datetime="…">Late Due Date: …</time></td>
 * </tr>
 * ```
 *
 * The second `dueDate` element, when present, is the late deadline and maps to
 * `lockAt`.
 */
export function parseAssignments(html: string, course: GradescopeCourse): Task[] {
  const tasks: Task[] = [];

  for (const row of html.split(/<tr\b/i).slice(1)) {
    const link = /<a\b([^>]*href="[^"]*\/assignments\/(\d+)[^"]*"[^>]*)>([\s\S]*?)<\/a>/i.exec(row);
    const button = /<button\b([^>]*data-assignment-id="(\d+)"[^>]*)>([\s\S]*?)<\/button>/i.exec(row);
    const found = link ?? button;
    const id = Number(found?.[2]);
    if (!found || !id) continue;

    const title = textOf(found[3] ?? "");
    if (!title) continue;

    const times = [...row.matchAll(/<time\b([^>]*)>/gi)].map((m) => ({
      kind: /submissionTimeChart--(\w+)/.exec(m[1] ?? "")?.[1],
      at: parseGradescopeTime(attr(m[1] ?? "", "datetime")),
    }));
    const release = times.find((t) => t.kind === "releaseDate")?.at ?? null;
    const [due, late] = times.filter((t) => t.kind === "dueDate").map((t) => t.at);

    const dueAt = due ?? null;
    const { submission, pointsPossible } = parseSubmission(row);

    const href = link ? attr(link[1] ?? "", "href") : null;
    const path = href?.startsWith("/") ? href : `/courses/${course.id}/assignments/${id}`;

    tasks.push({
      id: `gradescope:${id}`,
      source: "gradescope",
      canvasId: id,
      kind: "assignment",
      title,
      htmlUrl: `${GRADESCOPE_ORIGIN}${path}`,
      courseId: course.id,
      courseName: course.name,
      courseCode: course.shortName,
      dueAt,
      unlockAt: release,
      lockAt: late ?? dueAt,
      allDay: false,
      pointsPossible,
      submissionTypes: [],
      lockedForUser: false,
      submission,
    });
  }

  return tasks;
}
