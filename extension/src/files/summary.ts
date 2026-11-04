/**
 * The one-line result of a save run, worded so a larger sync never reads as downloading everything again:
 * "54 new (31 attachments, 9 images), 98 unchanged skipped, 0 failed".
 */

import type { ItemRole } from "./plan";
import type { RunResult } from "./runner";

const LABEL: Record<ItemRole, [one: string, many: string]> = {
  file: ["file", "files"],
  page: ["page", "pages"],
  attachment: ["attachment", "attachments"],
  image: ["image", "images"],
  handout: ["handout", "handouts"],
};
const ORDER: ItemRole[] = ["file", "page", "attachment", "image", "handout"];

/** What the new items were, largest groups in a fixed order, e.g. "31 attachments, 9 images". Empty when none were saved. */
export function whatChanged(result: Pick<RunResult, "outcomes">): string {
  const counts = new Map<ItemRole, number>();
  for (const o of result.outcomes) if (o.status === "saved" && o.role) counts.set(o.role, (counts.get(o.role) ?? 0) + 1);
  return ORDER.filter((role) => counts.has(role))
    .map((role) => {
      const n = counts.get(role) as number;
      return `${n} ${LABEL[role][n === 1 ? 0 : 1]}`;
    })
    .join(", ");
}

export function describeRun(result: Pick<RunResult, "saved" | "unchanged" | "failed" | "outcomes" | "cancelled">): string {
  const changed = whatChanged(result);
  return `${result.saved} new${changed ? ` (${changed})` : ""}, ${result.unchanged} unchanged skipped, ${result.failed} failed${result.cancelled ? " (stopped early)" : ""}`;
}
