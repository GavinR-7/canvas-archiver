/**
 * Weekly class schedule: the data model, the `schedule.json` export, and the
 * pure layout the weekly view draws from.
 *
 * Class times are never invented. They come only from what the person enters
 * or pastes (e.g. the table in gavin-data's knowledge/schedule.md); the list
 * starts empty. All times are wall-clock Eastern (the file says so).
 */

import { easternDay } from "@/src/dates/merge";

export const SCHEDULE_VERSION = 1;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export interface ClassMeeting {
  /** Stable within the file: `<course>-<kind>-<days>-<start>`, derived, so re-importing does not duplicate. */
  id: string;
  course: string;
  /** "Lecture", "Discussion", "Seminar", "Bowling"… as the person wrote it. */
  title: string;
  days: Day[];
  /** 24-hour "HH:MM". */
  start: string;
  end: string;
  location: string;
}

export interface ScheduleFile {
  version: typeof SCHEDULE_VERSION;
  generatedAt: string;
  timezone: "America/New_York";
  classes: ClassMeeting[];
}

// --- parsing ---------------------------------------------------------------

const DAY_WORDS: Record<string, Day> = {
  mon: "mon", monday: "mon", tue: "tue", tues: "tue", tuesday: "tue", wed: "wed", wednesday: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu", fri: "fri", friday: "fri", sat: "sat", saturday: "sat", sun: "sun", sunday: "sun",
  m: "mon", t: "tue", w: "wed", r: "thu", f: "fri",
};

export function parseDays(text: string): Day[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const out: Day[] = [];
  for (const w of words) {
    const day = DAY_WORDS[w];
    if (day) {
      if (!out.includes(day)) out.push(day);
    } else if (/^[mtwrf]{2,5}$/.test(w)) {
      // "MWF", "TR"
      for (const ch of w) {
        const d = DAY_WORDS[ch] as Day;
        if (!out.includes(d)) out.push(d);
      }
    }
  }
  return out.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
}

const TIME = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/gi;

function to24(h: number, m: number, mer: string | undefined): string | null {
  if (h < 1 || h > 12 || m > 59) return h <= 23 && !mer && m <= 59 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;
  let hour = h % 12;
  if (mer?.toLowerCase().startsWith("p")) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "10:10-11:00 am", "11:40 am-12:55 pm", "1:25-2:15 pm" → ["10:10","11:00"] etc. A bare start borrows the end's am/pm unless that would put it after the end. */
export function parseTimeRange(text: string): { start: string; end: string } | null {
  const parts = [...text.matchAll(TIME)].map((m) => ({ h: Number(m[1]), m: Number(m[2] ?? 0), mer: m[3]?.replace(/\./g, "").toLowerCase() }));
  if (parts.length !== 2) return null;
  const [a, b] = parts as [(typeof parts)[number], (typeof parts)[number]];
  const end = to24(b.h, b.m, b.mer);
  if (!end) return null;
  let start = to24(a.h, a.m, a.mer ?? b.mer);
  if (!start) return null;
  if (!a.mer && b.mer && start > end) start = to24(a.h, a.m, b.mer === "pm" ? "am" : "pm") ?? start; // "11:30-1:00 pm"
  return start < end ? { start, end } : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function meetingId(m: Pick<ClassMeeting, "course" | "title" | "days" | "start">): string {
  return `${slug(m.course)}-${slug(m.title)}-${m.days.join("")}-${m.start.replace(":", "")}`;
}

/** Split "ECE 3030 Lecture (EM Fields & Waves)" into course "ECE 3030" and title "Lecture (EM Fields & Waves)". */
function splitCourse(cell: string): { course: string; title: string } {
  const m = /^([A-Za-z]{2,5}\s?\d{4})\s*(.*)$/.exec(cell.trim());
  return m ? { course: (m[1] as string).replace(/\s+/, " ").toUpperCase(), title: (m[2] as string) || "Class" } : { course: cell.trim(), title: "Class" };
}

export interface ImportResult {
  classes: ClassMeeting[];
  /** Rows that looked like table rows but could not be read, so nothing is silently dropped. */
  skipped: string[];
}

/** Read a Markdown table with columns Course | Days | Time | Location (header and separator rows are ignored). */
export function parseScheduleTable(text: string): ImportResult {
  const classes: ClassMeeting[] = [];
  const skipped: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || /^\|[\s:|-]+\|?$/.test(line)) continue;
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 3 || /^course$/i.test(cells[0] as string)) continue;
    const { course, title } = splitCourse(cells[0] as string);
    const days = parseDays(cells[1] as string);
    const time = parseTimeRange(cells[2] as string);
    if (days.length === 0 || !time) { skipped.push(line); continue; }
    const meeting = { course, title, days, start: time.start, end: time.end, location: cells[3] ?? "" };
    classes.push({ id: meetingId(meeting), ...meeting });
  }
  return { classes, skipped };
}

// --- export ----------------------------------------------------------------

export function buildScheduleFile(classes: ClassMeeting[], now: Date): ScheduleFile {
  const sorted = [...classes].sort((a, b) => a.course.localeCompare(b.course) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { version: SCHEDULE_VERSION, generatedAt: now.toISOString(), timezone: "America/New_York", classes: sorted };
}

export const serializeSchedule = (file: ScheduleFile) => `${JSON.stringify(file, null, 2)}\n`;

export function sameSchedule(existing: string, next: ScheduleFile): boolean {
  try {
    const old = JSON.parse(existing) as Partial<ScheduleFile>;
    return JSON.stringify(old.classes) === JSON.stringify(next.classes) && old.version === next.version;
  } catch {
    return false;
  }
}

// --- week layout -----------------------------------------------------------

export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface Block {
  id: string;
  label: string;
  detail: string;
  /** Minutes since midnight, Eastern. */
  from: number;
  to: number;
  kind: "class" | "deadline";
  unconfirmed?: boolean;
}

export interface DayColumn {
  day: Day;
  /** Eastern calendar day, YYYY-MM-DD. */
  date: string;
  blocks: Block[];
  /** Deadlines with no clock time. */
  allDay: Block[];
}

export interface WeekDeadline {
  id: string;
  title: string;
  course: string;
  dueAt: string;
  allDay: boolean;
  unconfirmed?: boolean;
}

/** Monday (as YYYY-MM-DD) of the week containing `date` (YYYY-MM-DD). Pure calendar arithmetic, no time zone involved. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Seven columns for the week starting `monday`, classes first, deadlines placed at their Eastern time. */
export function layoutWeek(monday: string, classes: ClassMeeting[], deadlines: WeekDeadline[]): DayColumn[] {
  const columns: DayColumn[] = DAYS.map((day, i) => ({ day, date: addDays(monday, i), blocks: [], allDay: [] }));
  for (const c of classes) {
    for (const day of c.days) {
      const column = columns[DAYS.indexOf(day)] as DayColumn;
      column.blocks.push({ id: `${c.id}@${column.date}`, label: `${c.course} ${c.title}`.trim(), detail: c.location, from: minutes(c.start), to: minutes(c.end), kind: "class" });
    }
  }
  for (const d of deadlines) {
    const column = columns.find((col) => col.date === easternDay(d.dueAt));
    if (!column) continue;
    if (d.allDay) {
      column.allDay.push({ id: d.id, label: `${d.course}: ${d.title}`, detail: "", from: 0, to: 0, kind: "deadline", unconfirmed: d.unconfirmed });
      continue;
    }
    const [h, m] = clockFmt.format(new Date(d.dueAt)).split(":").map(Number) as [number, number];
    const at = h * 60 + m;
    column.blocks.push({ id: d.id, label: `${d.course}: ${d.title}`, detail: "due", from: Math.max(0, at - 20), to: at, kind: "deadline", unconfirmed: d.unconfirmed });
  }
  for (const column of columns) column.blocks.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
  return columns;
}

// --- storage ---------------------------------------------------------------

const KEY = "schedule.classes";

export async function loadClasses(): Promise<ClassMeeting[]> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    return Array.isArray(stored) ? (stored as ClassMeeting[]) : [];
  } catch {
    return [];
  }
}

export const saveClasses = (classes: ClassMeeting[]) => chrome.storage.local.set({ [KEY]: classes });
