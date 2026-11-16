/**
 * Automatic archive: how often, which courses, and where the files go.
 * The run itself happens on the Files page, opened by the background alarm.
 */

import { useEffect, useState } from "react";
import { splitCourses } from "@/src/canvas/visibility";
import { loadRoot, pickRoot, requestRootAccess, rootAccess, saveRoot, type RootAccess } from "@/src/files/handle-store";
import {
  DEFAULT_ARCHIVE_SCHEDULE,
  FREQUENCY_LABEL,
  loadArchiveSchedule,
  loadArchiveScheduleStatus,
  periodMinutes,
  saveArchiveSchedule,
  ARCHIVE_FREQUENCIES,
  type ArchiveFrequency,
  type ArchiveLocation,
  type ArchiveSchedule,
  type ArchiveScheduleStatus,
} from "@/src/files/schedule";
import { loadSnapshot } from "@/src/lib/storage";
import type { Course } from "@/src/types/canvas";
import { ShowAllCourses } from "@/src/ui/components";

const selectClass = "mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600";
const linkButton = "underline underline-offset-2";

function intervalText(frequency: ArchiveFrequency): string {
  const minutes = periodMinutes(frequency);
  if (minutes === null) return "Off.";
  if (minutes === 24 * 60) return "On. The next run is in one day, while Chrome is open.";
  if (minutes === 3 * 24 * 60) return "On. The next run is in 3 days, while Chrome is open.";
  return "On. The next run is in one week, while Chrome is open.";
}

export default function ArchiveScheduleSettings() {
  const [schedule, setSchedule] = useState<ArchiveSchedule>(DEFAULT_ARCHIVE_SCHEDULE);
  const [courses, setCourses] = useState<Course[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [rootName, setRootName] = useState<string | null>(null);
  const [access, setAccess] = useState<RootAccess>("prompt");
  const [note, setNote] = useState<string | null>(null);
  const [status, setStatus] = useState<ArchiveScheduleStatus | null>(null);

  useEffect(() => {
    void loadArchiveSchedule().then(setSchedule);
    void loadArchiveScheduleStatus().then(setStatus);
    void loadSnapshot().then((snapshot) => setCourses(snapshot.courses.filter((course) => !course.restricted)));
    void loadRoot().then(async (handle) => {
      setRootName(handle?.name ?? null);
      if (handle) setAccess(await rootAccess(handle));
    });
  }, []);

  const persist = async (next: ArchiveSchedule) => {
    setNote(null);
    if (next.frequency !== "off" && next.location === "folder" && access !== "granted") {
      setNote("Choose the archive folder and allow access before a scheduled run can use it. Downloads does not need a folder.");
      return;
    }
    const saved = { ...next, courseIds: next.courseIds === null ? null : [...new Set(next.courseIds)] };
    await saveArchiveSchedule(saved);
    setSchedule(saved);
    setNote(intervalText(saved.frequency));
  };

  const chooseFolder = async () => {
    setNote(null);
    try {
      const handle = await pickRoot();
      await saveRoot(handle);
      setRootName(handle.name);
      setAccess(await requestRootAccess(handle));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setNote(`Chrome would not use that folder: ${(error as Error).message}`);
      }
    }
  };

  const reconnect = async () => {
    const handle = await loadRoot();
    if (!handle) return;
    const granted = await requestRootAccess(handle);
    setAccess(granted);
    setRootName(handle.name);
  };

  const split = splitCourses(courses, new Date());
  const listed = showAll ? [...split.shown, ...split.hidden.map(({ course }) => course)] : split.shown;
  const selected = new Set(schedule.courseIds ?? []);

  const setFrequency = (frequency: ArchiveFrequency) => void persist({ ...schedule, frequency });
  const setLocation = (location: ArchiveLocation) => void persist({ ...schedule, location });

  const useCurrent = () => void persist({ ...schedule, courseIds: null });
  const useChecked = () => {
    const ids = schedule.courseIds ?? split.shown.map((course) => course.id);
    void persist({ ...schedule, courseIds: ids });
  };
  const toggleCourse = (id: number, on: boolean) => {
    const ids = new Set(schedule.courseIds ?? []);
    if (on) ids.add(id);
    else ids.delete(id);
    void persist({ ...schedule, courseIds: [...ids] });
  };

  return (
    <section className="mt-6">
      <h2 className="font-medium">Automatic archive</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Off until you choose a schedule. When it is on, Chrome opens the Files page in the background and saves new or
        changed Canvas files. Chrome has to be open. The first run waits one full interval. Gradescope handouts stay on
        the Files page, where you can review them before saving.
      </p>

      <label className="mt-3 block text-sm">
        How often
        <select
          className={selectClass}
          value={schedule.frequency}
          onChange={(event) => setFrequency(event.target.value as ArchiveFrequency)}
        >
          {ARCHIVE_FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {FREQUENCY_LABEL[frequency]}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Courses</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="archive-courses" checked={schedule.courseIds === null} onChange={useCurrent} />
          Current courses, whichever those are when the run starts
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="radio" name="archive-courses" checked={schedule.courseIds !== null} onChange={useChecked} />
          Only the courses I check
        </label>
        {schedule.courseIds !== null && (
          <>
            {listed.length === 0 ? (
              <p className="mt-2 text-sm">No courses yet. Open the extension once so it can load them.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {listed.map((course) => (
                  <li key={course.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(course.id)}
                        onChange={(event) => toggleCourse(course.id, event.target.checked)}
                      />
                      {course.courseCode || course.name}
                      {course.name !== course.courseCode && course.courseCode ? ` ${course.name}` : ""}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <ShowAllCourses hiddenCount={split.hidden.length} showAll={showAll} onToggle={() => setShowAll((value) => !value)} />
          </>
        )}
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Where files go</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="archive-location" checked={schedule.location === "folder"} onChange={() => setLocation("folder")} />
          The archive folder{rootName ? `: ${rootName}` : ""}
          {schedule.location === "folder" && access !== "granted" && rootName ? " (access needed)" : ""}
        </label>
        <p className="mt-1 text-sm">
          <button type="button" className={linkButton} onClick={() => void chooseFolder()}>
            {rootName ? "Change folder" : "Choose folder"}
          </button>
          {rootName && access !== "granted" && (
            <>
              {" "}
              <button type="button" className={linkButton} onClick={() => void reconnect()}>
                Reconnect
              </button>
            </>
          )}
        </p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Chrome will not let you pick Downloads, Documents, or Desktop themselves. Choose a folder inside one, such as Documents/School.
          This is the same folder the Files page uses.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="archive-location"
            checked={schedule.location === "downloads"}
            onChange={() => setLocation("downloads")}
          />
          Browser Downloads, under Downloads/Cornell
        </label>
      </fieldset>

      {note && (
        <p role="status" className="mt-3 text-sm">
          {note}
        </p>
      )}
      {status && (
        <p className={`mt-2 text-sm ${status.ok ? "" : "text-red-600 dark:text-red-400"}`}>
          Last archive {new Date(status.at).toLocaleString()}: {status.message}
        </p>
      )}
    </section>
  );
}
