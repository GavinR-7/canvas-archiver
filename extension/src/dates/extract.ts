/**
 * Finding exam dates in prose: syllabi and instructor announcements.
 *
 * Some tests never reach Canvas (the CS 3700 prelim is only in the syllabus),
 * so the planner cannot be the only source of deadlines. This reads text a
 * human wrote and returns *candidates*. They are always shown as unconfirmed:
 * a regex that finds "Prelim 1 - Oct 14, 7:30 PM" will also, sooner or later,
 * find something that is not a deadline, and the person must be able to tell.
 *
 * Pure: no network, no clock except the `now` argument.
 */

export const TIME_ZONE = "America/New_York";

export type CandidateKind = "exam" | "quiz";

export interface DateCandidate {
  title: string;
  kind: CandidateKind;
  /** The sentence it was found in, for the "why is this here" tooltip. */
  evidence: string;
  /** ISO 8601 UTC. */
  at: string;
  /** No clock time was stated, so `at` is the end of that day. */
  allDay: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const KEYWORD = /\b(prelim(?:inary)?s?|mid-?terms?|final(?:\s+exam)?s?|exams?|quiz(?:zes)?|tests?)\b/i;
const MONTH_NAME = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WRITTEN_DATE = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i");
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/;
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])/i;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&ndash;": "-", "&mdash;": "-" };

/** HTML to lines. Table cells on one row stay on one line, which is how syllabi lay out schedules. */
export function toLines(html: string): string[] {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|li|tr|div|h\d|ul|ol|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|ndash|mdash);/g, (e) => ENTITIES[e] ?? " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").replace(/(\|\s*)+$/, "").trim())
    .filter(Boolean);
}

/** Offset of `tz` from UTC at instant `ts`, in ms (negative west of Greenwich). */
function offsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock time in `tz` to a UTC instant. Handles DST on either side. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string = TIME_ZONE): Date {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return new Date(guess);
}

export type WallTime = { status: "ok" | "ambiguous"; date: Date } | { status: "gap"; date: null };

/**
 * A wall-clock time in `tz`, checked rather than guessed. A time the clocks skip (02:30 on the spring-forward
 * night) is a "gap" and has no instant. A time that happens twice (01:30 on the fall-back night) is "ambiguous"
 * and resolves to the earlier occurrence, the daylight-time one, so the caller can say which it used.
 */
export function resolveWallTime(y: number, m: number, d: number, h: number, mi: number, tz: string = TIME_ZONE): WallTime {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall + 86_400_000]) {
    const at = wall - offsetMs(probe, tz);
    if (wall === at + offsetMs(at, tz)) candidates.add(at);
  }
  if (candidates.size === 0) return { status: "gap", date: null };
  return { status: candidates.size > 1 ? "ambiguous" : "ok", date: new Date(Math.min(...candidates)) };
}

function validDay(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Pick a year for a date written without one: the nearest occurrence that is
 * not more than ~60 days in the past. A syllabus read in December that lists
 * "Jan 28" means next January.
 */
function inferYear(m: number, d: number, now: Date): number {
  const year = now.getUTCFullYear();
  const candidate = Date.UTC(year, m - 1, d, 12);
  return candidate < now.getTime() - 60 * 86_400_000 ? year + 1 : year;
}

function readClock(text: string): { h: number; mi: number; raw: string } | null {
  const match = CLOCK.exec(text);
  if (match) {
    let h = Number(match[1]);
    if (h < 1 || h > 12) return null;
    h = (h % 12) + ((match[3] as string).toLowerCase() === "p" ? 12 : 0);
    return { h, mi: Number(match[2] ?? 0), raw: match[0] };
  }
  const noon = /\bnoon\b/i.exec(text);
  return noon ? { h: 12, mi: 0, raw: noon[0] } : null;
}

function cleanTitle(line: string, removals: string[]): string {
  let title = line;
  for (const piece of removals) title = title.replace(piece, " ");
  title = title
    .replace(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat|sun)(?:day)?\b\.?,?/gi, " ")
    .replace(/\b(week|wk)\s*\d+\b/gi, " ")
    .replace(/[|•·–—\-:,;()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > 80) title = `${title.slice(0, 77).trimEnd()}…`;
  return title;
}

const SENTENCE_WORD = /\b(is|are|was|were|will|must|may|can|should|be|no|not|closed|open|book|policy|due|submit|submitted|homework|hw|assignment|project|lab|problem|set|quiz|reading)\b/i;

/** A line that is only an exam label ("Prelim 1", "Final Exam", "Midterm 2 (in class)"), not a sentence about exams. */
function isExamLabel(line: string): boolean {
  const words = line.replace(/[|•·–—\-:,;()]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length <= 5 && !SENTENCE_WORD.test(line);
}

/** A dated line that only gives the date and time ("Thursday, October 8, 7:30 PM", "Oct 8 · Statler 196"), with no other subject. */
function isDateContinuation(line: string): boolean {
  if (SENTENCE_WORD.test(line)) return false;
  const rest = line
    .replace(WRITTEN_DATE, " ")
    .replace(NUMERIC_DATE, " ")
    .replace(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat|sun)(?:day)?\b\.?/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\b/gi, " ")
    .replace(/[|•·–—\-:,;()]+/g, " ");
  return rest.trim().split(/\s+/).filter(Boolean).length <= 5;
}

/** Candidates in `html`. Dates in the past are included; callers decide the window. */
export function extractExamDates(html: string, now: Date): DateCandidate[] {
  const found: DateCandidate[] = [];

  const lines = toLines(html);
  for (const [index, own] of lines.entries()) {
    let line = own;
    const keyword = KEYWORD.exec(line);
    if (!keyword) continue;
    // PDF text often puts the date on the next line ("Prelim 1" / "Thursday, October 8, 7:30 PM").
    // Join it only when this line has no date and the next has one but no exam word of its own.
    const next = lines[index + 1];
    if (next && isExamLabel(line) && isDateContinuation(next) && !WRITTEN_DATE.test(line) && !NUMERIC_DATE.test(line) && !KEYWORD.test(next) && (WRITTEN_DATE.test(next) || NUMERIC_DATE.test(next))) {
      line = `${line} ${next}`;
    }
    // "Exams are closed-book" is a policy sentence, not a date.
    const written = WRITTEN_DATE.exec(line);
    const numeric = written ? null : NUMERIC_DATE.exec(line);
    if (!written && !numeric) continue;

    let y: number, m: number, d: number, dateText: string;
    if (written) {
      m = MONTHS[(written[1] as string).toLowerCase().replace(/\.$/, "")] as number;
      d = Number(written[2]);
      y = written[3] ? Number(written[3]) : inferYear(m, d, now);
      dateText = written[0];
    } else {
      const n = numeric as RegExpExecArray;
      m = Number(n[1]);
      d = Number(n[2]);
      y = n[3] ? (n[3].length === 2 ? 2000 + Number(n[3]) : Number(n[3])) : inferYear(m, d, now);
      dateText = n[0];
    }
    if (!validDay(y, m, d)) continue;

    // Look for a clock time only near the date, so "Section meets 2pm" elsewhere in a long line is ignored.
    const at = line.indexOf(dateText);
    const near = line.slice(Math.max(0, at - 40), at + dateText.length + 60);
    const clock = readClock(near);
    const utc = zonedToUtc(y, m, d, clock?.h ?? 23, clock?.mi ?? (clock ? 0 : 59));

    const word = (keyword[1] as string).toLowerCase();
    const kind: CandidateKind = /quiz|test/.test(word) ? "quiz" : "exam";
    const title = cleanTitle(line, [dateText, clock?.raw ?? ""]) || (keyword[1] as string);

    found.push({ title, kind, evidence: line.slice(0, 200), at: utc.toISOString(), allDay: clock === null });
  }

  // The same exam is often listed twice (overview and schedule table).
  const seen = new Set<string>();
  return found.filter((c) => {
    const key = `${c.at}|${c.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
