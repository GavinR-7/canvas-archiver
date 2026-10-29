/**
 * One feed run: save every course's new or changed material into the HQ inbox
 * (ingest layout + batch file). Runs in an extension page, because the folder
 * handle and a long download loop need one; the background alarm opens
 * `files.html?auto=feed` for it.
 */

import { fetchCourseSources } from "@/src/files/api";
import { INBOX_KEY, loadRoot, rootAccess } from "@/src/files/handle-store";
import { ingestLayout } from "@/src/files/layout";
import { loadDirBindings, rememberDirBindings } from "@/src/files/dirs";
import { planCourses } from "@/src/files/plan";
import { runArchive } from "@/src/files/runner";
import { folderSink, storageManifestStore } from "@/src/files/sinks";
import type { Course } from "@/src/types/canvas";
import { saveFeedStatus, type FeedStatus } from "./settings";

export function describeResult(r: { saved: number; unchanged: number; failed: number; elapsedMs: number; cancelled: boolean }): string {
  return `${r.saved} new or changed, ${r.unchanged} already saved, ${r.failed} failed, ${Math.round(r.elapsedMs / 1000)} s${r.cancelled ? " (stopped early)" : ""}`;
}

export async function runFeed(courses: Course[], signal?: AbortSignal): Promise<FeedStatus> {
  const finish = async (ok: boolean, message: string) => {
    const status: FeedStatus = { at: new Date().toISOString(), ok, message };
    await saveFeedStatus(status);
    return status;
  };

  const inbox = await loadRoot(INBOX_KEY);
  if (!inbox) return finish(false, "No inbox folder chosen. Choose it in Settings.");
  if ((await rootAccess(inbox)) !== "granted") {
    return finish(false, "Chrome needs you to allow the inbox folder again. Open Settings and press Reconnect.");
  }
  const active = courses.filter((c) => !c.restricted);
  if (active.length === 0) return finish(false, "No courses loaded. Sign in to Canvas in this browser.");

  try {
    const inputs = [];
    for (const course of active) inputs.push({ course, sources: await fetchCourseSources(course.id) });
    const plans = planCourses(inputs, ingestLayout, await loadDirBindings(ingestLayout.id));
    await rememberDirBindings(ingestLayout.id, plans);
    const result = await runArchive(plans, ingestLayout, folderSink(inbox), storageManifestStore(), { signal });
    return finish(result.failed === 0, describeResult(result));
  } catch (error) {
    return finish(false, `Feed failed: ${(error as Error).message}`);
  }
}
