/**
 * Exam dates stated in a course's syllabus *files* (PDF or text), not only the
 * Canvas syllabus page. Many syllabi are an attached PDF whose schedule table
 * holds the prelim and final dates.
 *
 * Once per sync, per file: a file is read only when its modified time changed
 * (the extracted candidates are cached by file id + modified time). Dates come
 * out as unconfirmed "syllabus" tasks like those from the page. A file that
 * cannot be read (the file host refuses a direct read, a scanned PDF with no
 * text layer) contributes nothing and is counted, never guessed at.
 *
 * Reads are GET only. Bytes come through `acquireCanvasFile` with no browser
 * download route: the extension must read the text, and a downloaded file
 * cannot be read back.
 */

import type { Course, Task } from "@/src/types/canvas";
import { extractExamDates, type DateCandidate } from "./extract";
import { candidateToTask } from "./tasks";

export interface SyllabusFile {
  id: number;
  name: string;
  /** Canvas's modified time, the cache key with the id. */
  updatedAt: string | null;
  url: string | null;
}

export interface SyllabusFileDeps {
  /** Syllabus-like files for a course: those the syllabus page links plus files named "syllabus". */
  listFiles(course: Course): Promise<SyllabusFile[]>;
  /** The file's text, or null when it cannot be read (blocked host, no text layer, not a supported type). */
  readText(file: SyllabusFile): Promise<string | null>;
  cache: { get(key: string): Promise<DateCandidate[] | undefined>; set(key: string, value: DateCandidate[]): Promise<void> };
}

export interface SyllabusFilesResult {
  tasks: Task[];
  /** Files or course file listings that could not be read this sync (shown once). */
  unreadable: number;
}

const SUPPORTED = /\.(pdf|txt|md|html?)$/i;
const DAY_MS = 86_400_000;

export async function syllabusFileTasks(
  courses: Course[],
  windowDays: number,
  deps: SyllabusFileDeps,
  now: Date = new Date(),
  overdueDays = 1,
): Promise<SyllabusFilesResult> {
  const tasks: Task[] = [];
  let unreadable = 0;
  const from = now.getTime() - overdueDays * DAY_MS;
  const to = now.getTime() + windowDays * DAY_MS;

  for (const course of courses) {
    let files: SyllabusFile[] = [];
    try {
      files = await deps.listFiles(course);
    } catch {
      unreadable++;
      continue;
    }
    for (const file of files.filter((f) => SUPPORTED.test(f.name))) {
      const key = `${file.id}:${file.updatedAt ?? ""}`;
      let candidates = await deps.cache.get(key);
      if (!candidates) {
        let text: string | null = null;
        try {
          text = await deps.readText(file);
        } catch {
          text = null;
        }
        if (text === null || text.trim() === "") {
          unreadable++;
          continue;
        }
        candidates = extractExamDates(text, now);
        await deps.cache.set(key, candidates);
      }
      const url = `${course.htmlUrl}/files/${file.id}`;
      for (const c of candidates) {
        const t = new Date(c.at).getTime();
        if (t >= from && t <= to) tasks.push(candidateToTask(c, course, "syllabus", url));
      }
    }
  }
  return { tasks, unreadable };
}
