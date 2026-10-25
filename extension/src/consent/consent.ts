/**
 * First-run consent.
 *
 * The Chrome Web Store requires a disclosure inside the extension itself, with
 * an affirmative click, before it handles user data. Nothing is fetched from
 * Canvas, Gradescope or Ed until this record exists. Bump CONSENT_VERSION when
 * the disclosure changes in a way that needs a fresh yes (a new data flow).
 */

export const CONSENT_VERSION = 1;
const CONSENT_KEY = "consent.v1";

export interface ConsentRecord {
  version: number;
  /** When the person clicked accept. ISO 8601 UTC. */
  acceptedAt: string;
}

/** What the screen tells the person, kept as data so the text and the tests share one source. */
export const DISCLOSURE = {
  reads: [
    "Your name, courses, assignments, due dates, announcements and syllabi from Canvas (canvas.cornell.edu).",
    "Your assignment due dates from Gradescope.",
    "Your course dates and staff announcements from Ed Discussion.",
    "Course files, only when you ask to save them.",
  ],
  writes: [
    "A cache of the above in this browser's extension storage.",
    "Course files into the folder you pick (or your Downloads folder if you choose that instead).",
  ],
  optional: [
    "Off by default: syncing your due dates to your own GitHub repository.",
    "Off by default: file picking, which sends file names to an AI provider using your own API key.",
    "Off by default, and asked course by course: course chat. If you allow a course, passages of its text go to your chosen AI provider (Anthropic) with your own key. Some instructors restrict AI tools, so check your course's policy.",
  ],
  never: [
    "It never changes anything in Canvas, Gradescope or Ed.",
    "It has no server, no account, no analytics and no ads. Nothing is sold or shared.",
  ],
} as const;

export function isValidConsent(record: unknown): record is ConsentRecord {
  if (typeof record !== "object" || record === null) return false;
  const { version, acceptedAt } = record as Partial<ConsentRecord>;
  return version === CONSENT_VERSION && typeof acceptedAt === "string" && !Number.isNaN(Date.parse(acceptedAt));
}

export function newConsent(now: Date): ConsentRecord {
  return { version: CONSENT_VERSION, acceptedAt: now.toISOString() };
}

/** True once the person accepted the current disclosure. Storage failure counts as "no". */
export async function hasConsent(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(CONSENT_KEY);
    return isValidConsent(stored[CONSENT_KEY]);
  } catch {
    return false;
  }
}

export async function acceptConsent(now = new Date()): Promise<void> {
  await chrome.storage.local.set({ [CONSENT_KEY]: newConsent(now) });
}

/** Withdraw consent; every surface goes back to the disclosure screen. */
export async function revokeConsent(): Promise<void> {
  await chrome.storage.local.remove(CONSENT_KEY);
}

export { CONSENT_KEY };
