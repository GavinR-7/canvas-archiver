/**
 * The model-assisted pick, behind the user's own Anthropic API key.
 *
 * Only names go out: module/folder names, file titles and the exam's
 * name and date. Never file contents, never Canvas URLs or ids beyond an
 * index. The reply is parsed as data and cut down to ids we sent.
 */

import type { Candidate } from "./pick";

export const MODEL = "claude-haiku-5-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

export interface AiSettings {
  enabled: boolean;
  apiKey: string;
}

export const DEFAULT_AI: AiSettings = { enabled: false, apiKey: "" };

const KEY = "ai.settings";

export async function loadAi(): Promise<AiSettings> {
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<AiSettings> | undefined;
    return { enabled: stored?.enabled === true, apiKey: typeof stored?.apiKey === "string" ? stored.apiKey : "" };
  } catch {
    return DEFAULT_AI;
  }
}

export const saveAi = (settings: AiSettings) => chrome.storage.local.set({ [KEY]: settings });

export interface ModelContext {
  request: string;
  course: string;
  /** Known exam dates for the course, e.g. "Prelim 1: 2026-09-30". */
  exams: string[];
}

/** Candidates are sent by index so the reply can only name things we listed. */
export function buildPrompt(context: ModelContext, candidates: Candidate[]): string {
  const rows = candidates.map((c, i) => `${i}\t${c.group || "-"}\t${c.title}\t${c.modifiedAt?.slice(0, 10) ?? "-"}`);
  return [
    `A student asks, for the course ${context.course}: "${context.request}".`,
    context.exams.length ? `Known exam dates: ${context.exams.join("; ")}.` : "",
    "Below are the course's files as: index, module/folder, file name, last modified. Choose the ones the student needs to study for what they asked (lecture material, homework and solutions in scope, past exams of that kind). Leave out material that is clearly for a different exam or unrelated.",
    'Reply with JSON only: {"picks":[{"i":<index>,"why":"<six words or fewer>"}]}',
    "",
    ...rows,
  ].filter(Boolean).join("\n");
}

export interface ModelPick {
  id: string;
  reason: string;
}

/** Pull the JSON object out of a reply (models sometimes fence it) and keep only valid, unique indexes. */
export function parseReply(reply: string, candidates: Candidate[]): ModelPick[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const picks = (data as { picks?: unknown })?.picks;
  if (!Array.isArray(picks)) return [];
  const seen = new Set<number>();
  const out: ModelPick[] = [];
  for (const p of picks) {
    const i = (p as { i?: unknown })?.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
    seen.add(i);
    const why = (p as { why?: unknown }).why;
    out.push({ id: (candidates[i] as Candidate).id, reason: typeof why === "string" ? why.slice(0, 80) : "chosen by the model" });
  }
  return out;
}

export async function askModel(settings: AiSettings, context: ModelContext, candidates: Candidate[], signal?: AbortSignal): Promise<ModelPick[]> {
  if (!settings.apiKey) throw new Error("No API key. Add one in Settings.");
  if (candidates.length === 0) return [];
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: buildPrompt(context, candidates) }],
    }),
  });
  if (!response.ok) {
    // Never echo the body or key: status is enough to act on.
    throw new Error(response.status === 401 ? "The API key was rejected." : `The model service answered ${response.status}.`);
  }
  const body = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return parseReply(text, candidates);
}
