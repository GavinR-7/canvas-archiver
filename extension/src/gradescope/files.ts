/**
 * Gradescope assignment handouts, for the file archive.
 *
 * Gradescope has no student API, so this reads the assignment page the signed-in
 * student sees and picks out links to files the instructor attached (a handout
 * or assignment PDF). Pure functions over strings here; the one network loop,
 * `listGradescopeFiles`, takes its page getter as a parameter so it is tested
 * without a browser.
 *
 * Nothing is verified against a live account (see NEXT.md, "Gradescope file
 * content"). Every extractor therefore degrades to "no file" rather than
 * throwing, and a failed assignment never stops the next one.
 */

import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import type { CourseSources, ExternalFile } from "@/src/files/plan";
import type { Course } from "@/src/types/canvas";
import { parseAssignments, type GradescopeCourse } from "./parse";

/** A file Gradescope serves for an assignment, ready to be planned. */
export interface GradescopeFile {
  /** Stable id: `gradescope:file/<assignmentId>/<fileKey>`. */
  source: string;
  gradescopeCourseId: number;
  assignmentId: number;
  assignmentTitle: string;
  /** File name to save as, with extension. */
  filename: string;
  /** Absolute URL on the Gradescope origin. Needs the session cookie; never log it. */
  url: string;
}

const ENTITY_AMP = /&amp;/g;

function hrefOf(tag: string): string | null {
  const match = /\bhref="([^"]*)"/i.exec(tag);
  return match?.[1] !== undefined ? match[1].replace(ENTITY_AMP, "&") : null;
}

function plainText(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function lastSegment(path: string): string {
  const segment = path.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Attached files on one assignment page.
 *
 * Reconstructed markup (see the fixture), an anchor to a PDF that is not the
 * student's own submission:
 *
 * ```html
 * <a class="actionBar--action" href="/courses/9/assignments/3/files/HW1.pdf">Download Assignment</a>
 * <a href="https://www.gradescope.com/courses/9/assignments/3/attachments/77/download">Handout</a>
 * ```
 *
 * Accepted: a link on the Gradescope host whose path sits under this
 * assignment (or `/attachments/`) and ends `.pdf` or `/download`. Rejected:
 * `/submissions/…` (the student's own work, not a handout), links to other
 * assignments, and any other host.
 */
export function parseHandouts(
  html: string,
  gradescopeCourseId: number,
  assignmentId: number,
  assignmentTitle: string,
): GradescopeFile[] {
  const base = `/courses/${gradescopeCourseId}/assignments/${assignmentId}`;
  const found = new Map<string, GradescopeFile>();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = hrefOf(match[1] ?? "");
    if (!href) continue;

    let url: URL;
    try {
      url = new URL(href, GRADESCOPE_ORIGIN);
    } catch {
      continue;
    }
    if (url.origin !== GRADESCOPE_ORIGIN) continue;

    const path = url.pathname;
    if (/\/submissions\//i.test(path)) continue;
    const underAssignment = path.startsWith(`${base}/`);
    const attachment = /^\/courses\/\d+\/(?:assignments\/\d+\/)?attachments\//i.test(path);
    if (!underAssignment && !(attachment && path.startsWith(`/courses/${gradescopeCourseId}/`))) continue;
    if (!/\.pdf$/i.test(path) && !/\/download$/i.test(path)) continue;
    if (found.has(path)) continue;

    const named = lastSegment(path);
    const label = plainText(match[2] ?? "");
    const fileName = /\.pdf$/i.test(named) ? named : `${label || assignmentTitle || "handout"}.pdf`;

    found.set(path, {
      source: `gradescope:file/${assignmentId}/${path.replace(/^\/courses\/\d+\//, "").replace(/\//g, "_")}`,
      gradescopeCourseId,
      assignmentId,
      assignmentTitle,
      filename: fileName,
      url: `${GRADESCOPE_ORIGIN}${path}`,
    });
  }

  return [...found.values()];
}

/** `"CS 3700"`, `"CS3700"` and `"cs-3700 FA26"` all become `"cs3700"`. */
function codeKey(text: string): string | null {
  const match = /\b([A-Za-z]{2,5})[\s-]?(\d{4})\b/.exec(text);
  return match ? `${match[1]}${match[2]}`.toLowerCase() : null;
}

/**
 * The Canvas course a Gradescope course belongs to, by department+number.
 * Null when nothing matches or two Canvas courses would (a lecture and a
 * section share a code: better to give the files their own folder than to
 * guess).
 */
export function matchCanvasCourse(
  course: Pick<GradescopeCourse, "shortName" | "name">,
  canvas: Pick<Course, "id" | "name" | "courseCode">[],
): Pick<Course, "id" | "name" | "courseCode"> | null {
  const wanted = codeKey(course.shortName) ?? codeKey(course.name);
  if (!wanted) return null;
  const hits = canvas.filter((c) => codeKey(c.courseCode) === wanted || codeKey(c.name) === wanted);
  return hits.length === 1 ? (hits[0] as Pick<Course, "id" | "name" | "courseCode">) : null;
}

export interface GradescopeCourseFiles {
  course: GradescopeCourse;
  files: GradescopeFile[];
}

export interface GradescopeListing {
  courses: GradescopeCourseFiles[];
  /** Per-page problems. A non-empty list never means the rest is wrong. */
  errors: string[];
}

export type PageGetter = (path: string) => Promise<string>;

/**
 * Handouts for the given courses. A page that fails is recorded and skipped;
 * the loop is sequential (Gradescope documents no rate limit) and `signal`
 * ends it between pages.
 */
export async function listGradescopeFiles(
  courses: GradescopeCourse[],
  getPage: PageGetter,
  signal?: AbortSignal,
  /** Filled as pages arrive, so a caller that gives up early still has what was read. */
  listing: GradescopeListing = { courses: [], errors: [] },
): Promise<GradescopeListing> {

  for (const course of courses) {
    if (signal?.aborted) break;
    let assignments;
    try {
      assignments = parseAssignments(await getPage(`/courses/${course.id}`), course);
    } catch (error) {
      listing.errors.push(`${course.shortName}: ${(error as Error).message}`);
      continue;
    }

    const files: GradescopeFile[] = [];
    for (const task of assignments) {
      if (signal?.aborted) break;
      try {
        const path = new URL(task.htmlUrl).pathname;
        files.push(...parseHandouts(await getPage(path), course.id, task.canvasId, task.title));
      } catch (error) {
        listing.errors.push(`${course.shortName} / ${task.title}: ${(error as Error).message}`);
      }
    }
    listing.courses.push({ course, files });
  }

  return listing;
}

/**
 * The handouts of the Gradescope course that belongs to one Canvas course, as plan inputs.
 * Empty when none matches (or two Canvas courses would), so a handout is never filed under a guess.
 */
export function handoutsFor(
  listing: GradescopeListing,
  course: Pick<Course, "id">,
  canvas: Pick<Course, "id" | "name" | "courseCode">[],
): ExternalFile[] {
  return listing.courses
    .filter((entry) => matchCanvasCourse(entry.course, canvas)?.id === course.id)
    .flatMap((entry) => entry.files.map(toExternal));
}

type CourseInput = { course: Pick<Course, "id" | "name" | "courseCode">; sources: CourseSources };

const toExternal = (file: GradescopeFile): ExternalFile => ({
  source: file.source,
  system: "gradescope",
  filename: file.filename,
  url: file.url,
});

/**
 * Add Gradescope handouts to the Canvas course inputs. A Gradescope course
 * that matches exactly one Canvas course lands in that course's folder; one
 * that matches none gets a folder of its own, with a negative id (Gradescope
 * and Canvas ids are separate number spaces) so its manifest cannot collide.
 * Courses with no handouts add nothing.
 */
export function withGradescope(inputs: CourseInput[], listing: GradescopeListing): CourseInput[] {
  const out = inputs.map((input) => ({
    course: input.course,
    sources: { ...input.sources, external: [...(input.sources.external ?? [])] },
  }));
  const extra: CourseInput[] = [];

  for (const { course, files } of listing.courses) {
    if (files.length === 0) continue;
    const external = files.map(toExternal);
    const home = matchCanvasCourse(course, inputs.map((i) => i.course));
    const target = out.find((o) => o.course.id === home?.id);
    if (target) {
      target.sources.external.push(...external);
    } else {
      extra.push({
        course: { id: -course.id, name: course.name, courseCode: course.shortName },
        sources: { modules: [], files: [], folders: [], documents: [], external },
      });
    }
  }

  return [...out, ...extra];
}
