import type { Snapshot } from "@/src/lib/messages";
import { buildDueFile, sameContent, serialize } from "./due";
import { putFile, type SyncOutcome, type SyncSettings } from "./github";
import { saveStatus } from "./settings";

/** Push the snapshot's deadlines if the person turned sync on. Records the outcome for the options page. */
export async function syncDue(
  snapshot: Snapshot,
  settings: SyncSettings,
  now: Date = new Date(),
  doFetch: typeof fetch = fetch,
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
  const message =
    outcome.status === "failed" ? outcome.message : outcome.status === "unchanged" ? `Up to date (${file.items.length} deadlines).` : `Wrote ${file.items.length} deadlines.`;
  await saveStatus({ at: now.toISOString(), ok: outcome.status !== "failed", message });
  return outcome;
}
