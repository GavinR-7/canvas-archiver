/**
 * "Get everything for prelim 2": choose files from a course archive plan.
 *
 * Pure and deterministic. The obvious cases (module named after the exam,
 * "weeks 3-6", "lectures 10 to 18", what the syllabus says the exam covers)
 * need no model; `needsModel` says when this layer found nothing solid, so the
 * UI can offer the model-assisted pick instead. Every pick carries its
 * reasons, because "why is this in my folder" must have an answer.
 */

import { toLines } from "@/src/dates/extract";
import type { CoursePlan } from "@/src/files/plan";

export interface Candidate {
  id: string;
  /** Module or folder name, e.g. "05 EM Waves". Empty for loose items. */
  group: string;
  /** File name or document title. */
  title: string;
  modifiedAt: string | null;
}

export type ExamWord = "prelim" | "midterm" | "final" | "exam" | "quiz";

export interface ParsedRequest {
  exam: { word: ExamWord; n: number | null } | null;
  /** Inclusive ranges asked for directly: "weeks 3-6", "lectures 10 to 18", "module 4". */
  ranges: { unit: Unit; from: number; to: number }[];
}

export type Unit = "week" | "lecture" | "module" | "chapter";

const UNIT_WORD = "(week|wk|lecture|lec|module|mod|chapter|ch|unit)s?";
const UNIT_MAP: Record<string, Unit> = {
  week: "week", wk: "week", lecture: "lecture", lec: "lecture", module: "module", mod: "module", chapter: "chapter", ch: "chapter", unit: "module",
};
const RANGE = new RegExp(`\\b${UNIT_WORD}\\.?\\s*(\\d{1,2})(?:\\s*(?:-|–|to|through|thru)\\s*(\\d{1,2}))?\\b`, "gi");
const EXAM = /\b(prelim(?:inary)?|mid-?term|final|exam|quiz)s?\.?\s*#?(\d{1,2})?\b/i;

export function normalizeExamWord(word: string): ExamWord {
  const w = word.toLowerCase();
  if (w.startsWith("prelim")) return "prelim";
  if (w.startsWith("mid")) return "midterm";
  if (w.startsWith("final")) return "final";
  if (w.startsWith("quiz")) return "quiz";
  return "exam";
}

export function ranges(text: string): ParsedRequest["ranges"] {
  const out: ParsedRequest["ranges"] = [];
  for (const m of text.matchAll(RANGE)) {
    const unit = UNIT_MAP[(m[1] as string).toLowerCase()] as Unit;
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    if (to >= from) out.push({ unit, from, to });
  }
  return out;
}

export function parseRequest(text: string): ParsedRequest {
  const m = EXAM.exec(text);
  const exam = m ? { word: normalizeExamWord(m[1] as string), n: m[2] ? Number(m[2]) : null } : null;
  return { exam, ranges: ranges(text) };
}

/** Does `text` name this exam ("Prelim 2", "prelim2", "Exam #2", "Midterm II")? */
export function namesExam(text: string, exam: { word: ExamWord; n: number | null }): boolean {
  const lower = text.toLowerCase();
  const word = exam.word === "midterm" ? "mid-?terms?" : exam.word === "prelim" ? "prelim(?:inary)?s?" : `${exam.word}s?`;
  const re = new RegExp(`\\b${word}\\s*#?(\\d{1,2}|i{1,3})?\\b`, "g");
  for (const m of lower.matchAll(re)) {
    const tag = m[1];
    if (exam.n === null) return true; // "the final": any mention of the word
    if (tag && (tag === String(exam.n) || tag === "i".repeat(exam.n))) return true;
  }
  return false;
}

/** Is `text` about a *different* numbered exam of the same kind? ("prelim 1 solutions" when asking prelim 2) */
export function namesOtherExam(text: string, exam: { word: ExamWord; n: number | null }): boolean {
  if (exam.n === null) return false;
  const lower = text.toLowerCase();
  const word = exam.word === "midterm" ? "mid-?terms?" : exam.word === "prelim" ? "prelim(?:inary)?s?" : `${exam.word}s?`;
  const re = new RegExp(`\\b${word}\\s*#?(\\d{1,2})\\b`, "g");
  const others = [...lower.matchAll(re)].map((m) => Number(m[1]));
  return others.length > 0 && !others.includes(exam.n);
}

/** Leading number of a module folder or file name: "05 EM Waves" → 5, "Week 3" → 3. */
export function leadingNumber(text: string): number | null {
  const m = /^\s*(?:(?:week|wk|lecture|lec|module|mod|chapter|ch|unit)s?\.?\s*)?(\d{1,2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * What the syllabus says an exam covers, e.g. "Prelim 2 covers lectures 10-18"
 * or a schedule row "Oct 21 | Prelim 2 (weeks 6-9)". Returns the ranges found
 * on lines that name the exam; empty when the syllabus says nothing usable.
 */
export function coverageFromSyllabus(syllabusHtml: string, exam: { word: ExamWord; n: number | null }): ParsedRequest["ranges"] {
  const out: ParsedRequest["ranges"] = [];
  for (const line of toLines(syllabusHtml)) {
    if (!namesExam(line, exam)) continue;
    if (!/cover|material|includes?|through|up to|scope|\(/i.test(line)) continue;
    out.push(...ranges(line));
  }
  return out;
}

export interface Picked {
  id: string;
  score: number;
  reasons: string[];
}

export interface PickResult {
  picked: Picked[];
  /** True when nothing scored as solid evidence: offer the model-assisted pick. */
  needsModel: boolean;
}

const STRONG = 6;

export interface PickInput {
  request: string;
  candidates: Candidate[];
  /** Ranges from the course syllabus for the requested exam (see coverageFromSyllabus). */
  syllabusRanges?: ParsedRequest["ranges"];
  /** Exam date and the previous exam's date, ISO. Files modified in between score weakly. */
  window?: { after: string | null; until: string } | null;
}

export function pickFiles({ request, candidates, syllabusRanges = [], window = null }: PickInput): PickResult {
  const parsed = parseRequest(request);
  const wanted = [...parsed.ranges.map((r) => ({ ...r, why: "you asked for" })), ...syllabusRanges.map((r) => ({ ...r, why: "the syllabus says the exam covers" }))];
  const picks: Picked[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];
    let score = 0;
    const add = (points: number, why: string) => { score += points; reasons.push(why); };
    const both = `${c.group} ${c.title}`;

    if (parsed.exam) {
      if (namesOtherExam(both, parsed.exam)) continue; // labelled for a different exam
      if (namesExam(c.group, parsed.exam)) add(10, `folder "${c.group}" is named for the exam`);
      else if (namesExam(c.title, parsed.exam)) add(8, "its name mentions the exam");
    }

    const groupNo = leadingNumber(c.group);
    const titleNo = leadingNumber(c.title);
    for (const r of wanted) {
      for (const [n, where] of [[groupNo, "folder"], [titleNo, "name"]] as const) {
        if (n !== null && n >= r.from && n <= r.to) {
          // A module folder number only counts as a "week/lecture" match when asked in module terms; otherwise weaker.
          add(r.unit === "module" || where === "name" ? 6 : 4, `${where} number ${n} is in ${r.unit}s ${r.from}-${r.to}, which ${r.why}`);
        }
      }
      const word = new RegExp(`\\b${r.unit}s?\\.?\\s*0?(\\d{1,2})\\b`, "i").exec(both);
      if (word && Number(word[1]) >= r.from && Number(word[1]) <= r.to) add(6, `mentions ${r.unit} ${word[1]}, within ${r.from}-${r.to}`);
    }

    if (window && c.modifiedAt) {
      const t = new Date(c.modifiedAt).getTime();
      const after = window.after ? new Date(window.after).getTime() : -Infinity;
      if (t > after && t <= new Date(window.until).getTime()) add(1, "last changed between the previous exam and this one");
    }
    if (score > 0) picks.push({ id: c.id, score, reasons });
  }

  picks.sort((a, b) => b.score - a.score);
  // Weak evidence alone (dates) is not a pick: it only breaks ties among solid ones.
  const solid = picks.filter((p) => p.score >= STRONG);
  return { picked: solid, needsModel: solid.length === 0 };
}

const GROUP_SKIP = new Set(["course files", "pages", "assignments", "announcements", "syllabus", "files", "_syllabus"]);

/** Flatten a course plan into candidates: group = the folder directly below the course. */
export function candidatesFromPlan(plan: Pick<CoursePlan, "dir" | "items">): Candidate[] {
  return plan.items.map((item) => {
    const below = item.path.slice(plan.dir.length);
    const group = below.length > 1 && !GROUP_SKIP.has((below[0] as string).toLowerCase()) ? (below[0] as string) : "";
    return { id: item.source, group, title: below[below.length - 1] as string, modifiedAt: item.modifiedAt };
  });
}
