import type { Snapshot } from "@/src/lib/messages";
import { buildDueFile, sameContent, serialize } from "./due";
import { putFile, type SyncOutcome, type SyncSettings } from "./github";
import { buildScheduleFile, sameSchedule, serializeSchedule, type ClassMeeting } from "@/src/schedule/model";
import { saveStatus } from "./settings";

/** schedule.json sits next to due.json: `notes/due.json` → `notes/schedule.json`. */
export const schedulePath = (duePath: string) => duePath.replace(/[^/]*$/, "") + "schedule.json";

/** Push the snapshot's deadlines if the person turned sync on. Records the outcome for the options page. */
export async function syncDue(
  snapshot: Snapshot,
  settings: SyncSettings,
  now: Date = new Date(),
  doFetch: typeof fetch = fetch,
  classes: ClassMeeting[] = [],
): Promise<SyncOutcome | null> {
  if (!settings.enabled) return null;
  // Nothing fetched yet (or Canvas failed with an empty cache): never overwrite a good file with an empty one.
  if (!snapshot.fetchedAt || snapshot.tasks.length === 0) {
    const outcome: SyncOutcome = { status: "failed", message: "No deadlines loaded yet; sync skipped." };
    await saveStatus({ at: now.toISOString(), ok: false, message: outcome.message });
    return outcome;
  }
  const file = buildDueFile(snapshot.tasks, now);
  const outcome = await putFile(settings, serialize(file), (existing) => sameContent(existing, file), `chore: update ${settings.path} (${file.items.length} deadlines)`, doFetch);
  // Classes go in the same pass, only when the person has entered some.
  let scheduleNote = "";
  if (classes.length > 0 && outcome.status !== "failed") {
    const schedule = buildScheduleFile(classes, now);
    const sent = await putFile(
      { ...settings, path: schedulePath(settings.path) },
      serializeSchedule(schedule),
      (existing) => sameSchedule(existing, schedule),
      `chore: update schedule.json (${classes.length} meetings)`,
      doFetch,
    );
    scheduleNote = sent.status === "failed" ? ` Schedule not sent: ${sent.message}` : ` Schedule: ${sent.status === "unchanged" ? "up to date" : "written"}.`;
  }
  const message =
    outcome.status === "failed" ? outcome.message : outcome.status === "unchanged" ? `Up to date (${file.items.length} deadlines).` : `Wrote ${file.items.length} deadlines.`;
  const full = message + scheduleNote;
  await saveStatus({ at: now.toISOString(), ok: outcome.status !== "failed", message: full });
  return outcome;
}
