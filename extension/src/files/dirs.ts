/**
 * Which folder each Canvas course owns, remembered across runs.
 *
 * Two courses can have the same name (a re-run section, a code reused across
 * terms). Which one gets the plain name must not depend on what is selected
 * today, or selecting only the second would aim it at the first one's folder.
 * So the first run that writes a course fixes its folder name against the
 * immutable Canvas course id, per layout.
 */

import { bindingsOf, type CoursePlan, type DirBindings } from "./plan";

const prefix = "archiveDirs:";

export async function loadDirBindings(layoutId: string): Promise<DirBindings> {
  try {
    const key = `${prefix}${layoutId}`;
    const stored = (await chrome.storage.local.get(key))[key] as DirBindings | undefined;
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Remember the folders these plans are about to write. Call before the run.
 * Throws if a course is already bound to another folder, or the folder to
 * another course (the plans were made from stale bindings): nothing is written.
 */
export async function rememberDirBindings(layoutId: string, plans: CoursePlan[]): Promise<void> {
  const stored = await loadDirBindings(layoutId);
  const owners = new Map(Object.entries(stored).map(([id, name]) => [name.toLowerCase(), Number(id)]));
  const next: DirBindings = { ...stored };
  for (const [idText, name] of Object.entries(bindingsOf(plans))) {
    const id = Number(idText);
    if (stored[id] !== undefined && stored[id] !== name) {
      throw new Error(`Course ${id} already has its own folder (${stored[id]}). Rebuild the plan and try again.`);
    }
    const owner = owners.get(name.toLowerCase());
    if (owner !== undefined && owner !== id) {
      throw new Error(`The folder ${name} belongs to another course. Rebuild the plan and try again.`);
    }
    next[id] = name;
  }
  await chrome.storage.local.set({ [`${prefix}${layoutId}`]: next });
}
