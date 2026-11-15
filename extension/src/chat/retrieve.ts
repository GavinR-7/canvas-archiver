/**
 * Retrieval over a course's text, pure and local: chunk documents, rank with
 * BM25, return passages with where they came from. No model is involved, so
 * "what would the chat see for this question" is testable and inspectable.
 */

import { toLines } from "@/src/dates/extract";

export interface Doc {
  /** Stable id, e.g. `canvas:page/week-3`. */
  source: string;
  /** Relative path shown in citations, e.g. `Pages/Week 3.html`. */
  path: string;
  html: string;
}

export interface Chunk {
  source: string;
  path: string;
  /** Nearest preceding heading-like line, for `§` citations. Empty if none. */
  section: string;
  text: string;
}

const TARGET = 700;
const HEADING_MAX = 80;

const looksLikeHeading = (line: string) => line.length <= HEADING_MAX && !/[.!?]$/.test(line) && /[A-Za-z]/.test(line);

export function chunkDoc(doc: Doc): Chunk[] {
  const chunks: Chunk[] = [];
  let section = "";
  let buffer: string[] = [];
  let size = 0;
  let bufferSection = "";
  const flush = () => {
    if (buffer.length) chunks.push({ source: doc.source, path: doc.path, section: bufferSection, text: buffer.join("\n") });
    buffer = [];
    size = 0;
  };
  for (const line of toLines(doc.html)) {
    if (looksLikeHeading(line)) {
      flush();
      section = line;
    }
    if (buffer.length === 0) bufferSection = section;
    buffer.push(line);
    size += line.length + 1;
    if (size >= TARGET) flush();
  }
  flush();
  return chunks;
}

const STOP = new Set("a an and are as at be by can do does for from has have how i in is it its of on or that the this to was what when where which who why will with you your about into than then there these they we".split(" "));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => !STOP.has(t) && t.length > 1)
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)); // crude plural fold
}

export interface Index {
  chunks: Chunk[];
  terms: Map<string, number>[];
  lengths: number[];
  df: Map<string, number>;
  avgLength: number;
}

export function buildIndex(chunks: Chunk[]): Index {
  const terms: Map<string, number>[] = [];
  const lengths: number[] = [];
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    // The path and section are searchable too: "prelim 2 review" should find a page by its title.
    const tokens = tokenize(`${chunk.path} ${chunk.section} ${chunk.text}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    terms.push(tf);
    lengths.push(tokens.length);
  }
  const avgLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  return { chunks, terms, lengths, df, avgLength };
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

const K1 = 1.4;
const B = 0.75;

export function search(index: Index, query: string, limit = 8): Hit[] {
  const q = [...new Set(tokenize(query))];
  const n = index.chunks.length;
  const hits: Hit[] = [];
  for (let i = 0; i < n; i++) {
    const tf = index.terms[i] as Map<string, number>;
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const df = index.df.get(term) as number;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * (index.lengths[i] as number)) / (index.avgLength || 1)));
    }
    if (score > 0) hits.push({ chunk: index.chunks[i] as Chunk, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
