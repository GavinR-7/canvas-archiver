/**
 * "Find (no AI)": course chat without a key.
 *
 * Retrieval is already local (retrieve.ts), so with no AI key the chat shows
 * the best matching passages as they are, each with its citation, and marks the
 * dates in them. Nothing leaves the browser in this mode: this file has no
 * network code, and the page does not call one for it.
 */

import type { AiSettings } from "@/src/ai/model";
import { search, type Index } from "./retrieve";

export type ChatMode = "ai" | "find";

/** The AI mode needs the key and both opt-ins; anything less is find mode. */
export function chatMode(ai: AiSettings): ChatMode {
  return ai.enabled && ai.apiKey && ai.allowContent ? "ai" : "find";
}

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const WEEKDAY = "(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs?)?|Fri|Sat(?:ur)?|Sun)(?:day)?\\.?";
const DATE = new RegExp(
  [
    `(?:${WEEKDAY},?\\s+)?${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, // Tuesday, Oct 28, 2026
    "\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b", // 10/28, 10/28/26
    "\\b\\d{1,2}(?::\\d{2})?\\s?(?:[AaPp]\\.?[Mm]\\b\\.?)", // 7:30 PM, 11pm
    `\\b${WEEKDAY.replace("\\.?", "")}\\b`, // Tuesday
  ].join("|"),
  "gi",
);

export interface Segment {
  text: string;
  /** True for a date or time, shown in bold. */
  date: boolean;
}

/** Split text into plain and date segments; joining the texts gives the input back. */
export function markDates(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(DATE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), date: false });
    out.push({ text: m[0], date: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), date: false });
  return out;
}

export interface FoundPassage {
  n: number;
  /** README citation form: `[ECE 3030 · Pages/Week 3.html §Skin depth]` */
  label: string;
  segments: Segment[];
}

/** The top passages for a question, straight from the course text, no model. Empty when nothing matches. */
export function findPassages(index: Index, question: string, course: string, limit = 5): FoundPassage[] {
  return search(index, question, limit).map((hit, i) => {
    const section = hit.chunk.section ? ` §${hit.chunk.section}` : "";
    return {
      n: i + 1,
      label: `[${course} · ${hit.chunk.path}${section}]`,
      segments: markDates(hit.chunk.text),
    };
  });
}
