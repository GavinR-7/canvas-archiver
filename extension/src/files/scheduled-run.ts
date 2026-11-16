/**
 * One unattended archive. The alarm opens `files.html?auto=archive` because
 * a folder handle and a long download loop need a page. Canvas files only;
 * Gradescope handouts stay on the Files page, where they can be reviewed.
 */

import { fetchCourseSources } from "@/src/files/api";
import { loadDirBindings, rememberDirBindings } from "@/src/files/dirs";
import { loadRoot, rootAccess } from "@/src/files/handle-store";
import { archiveLayout } from "@/src/files/layout";
import { planCourses } from "@/src/files/plan";
import { runArchive } from "@/src/files/runner";
import { downloadsSink, folderManifestStore, folderSink } from "@/src/files/sinks";
import type { Course } from "@/src/types/canvas";
import {
  coursesToArchive,
  loadArchiveSchedule,
  saveArchiveScheduleStatus,
  type ArchiveScheduleStatus,
} from "./schedule";

export async function runScheduledArchive(courses: Course[], signal?: AbortSignal): Promise<ArchiveScheduleStatus> {
  const finish = async (ok: boolean, message: string) => {
    const status: ArchiveScheduleStatus = { at: new Date().toISOString(), ok, message };
    await saveArchiveScheduleStatus(status);
    return status;
  };

  const schedule = await loadArchiveSchedule();
  if (schedule.frequency === "off") return finish(false, "Automatic archive is off.");

  const picked = coursesToArchive(courses, schedule, new Date());
  if (picked.length === 0) {
    return finish(
      false,
      schedule.courseIds === null
        ? "No current courses to archive. Sign in to Canvas in this browser."
        : "No selected courses to archive. Check at least one in Settings, or use current courses.",
    );
  }

  let sink;
  if (schedule.location === "downloads") {
    sink = downloadsSink();
  } else {
    const root = await loadRoot();
    if (!root || (await rootAccess(root)) !== "granted") {
      return finish(false, "No archive folder with access. Choose it in Settings, or switch the location to Downloads.");
    }
    sink = folderSink(root, { downloadsFallback: true });
  }

  try {
    const inputs = [];
    for (const course of picked) inputs.push({ course, sources: await fetchCourseSources(course.id) });
    const plans = planCourses(inputs, archiveLayout, await loadDirBindings(archiveLayout.id));
    await rememberDirBindings(archiveLayout.id, plans);
    const result = await runArchive(plans, archiveLayout, sink, folderManifestStore(sink), { signal });
    const where = schedule.location === "downloads" ? "Downloads/Cornell" : "the archive folder";
    return finish(
      result.failed === 0,
      `${result.saved} new or changed, ${result.unchanged} already saved, ${result.failed} failed, under ${where}.`,
    );
  } catch (error) {
    return finish(false, `Archive failed: ${(error as Error).message}`);
  }
}
