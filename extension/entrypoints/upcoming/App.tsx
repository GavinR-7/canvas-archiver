/**
 * The "Upcoming" extension page.
 *
 * An extension page is just an HTML file the extension ships, opened in a
 * normal tab via `chrome.tabs.create({ url: chrome.runtime.getURL(...) })`. It
 * has the same origin and permissions as the popup, but a full tab's worth of
 * room and a lifetime that does not end when focus moves elsewhere.
 *
 * Open work due in the next 14 days, plus missing and overdue tasks in the
 * snapshot. Filter by course or include completed work as needed.
 */

import { useEffect, useMemo, useState } from "react";
import { upcomingWork, workCourseKey } from "@/src/lib/upcoming-work";
import { UPCOMING_DAYS } from "@/src/canvas/api";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import { ED_ORIGINS } from "@/src/config/ed";
import { examsByCourse } from "@/src/dates/exams";
import { loadManualExams, MANUAL_EXAMS_KEY, withManualExams, type ManualExams } from "@/src/dates/manual-exams";
import { taskStatus } from "@/src/lib/task-status";
import { formatDay, formatTime, localDayKey, relativeDay, relativeDistance } from "@/src/lib/time";
import { useNow } from "@/src/ui/useNow";
import type { Task } from "@/src/types/canvas";
import { EmptyState, ErrorBanner, KindBadge, SourceBadge, Spinner, StatusBadge } from "@/src/ui/components";
import { useSnapshot } from "@/src/ui/useSnapshot";

/** Group tasks by local calendar day, preserving due-date order. */
function groupByDay(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    if (!task.dueAt) continue;
    const key = localDayKey(task.dueAt);
    const existing = groups.get(key);
    if (existing) existing.push(task);
    else groups.set(key, [task]);
  }

  return [...groups.entries()];
}

function TaskRow({ task, now, showDay = false }: { task: Task; now: Date; showDay?: boolean }) {
  const status = taskStatus(task, now);
  const dueAt = task.dueAt && Number.isFinite(Date.parse(task.dueAt)) ? task.dueAt : null;
  const time = dueAt ? (task.allDay ? "All day" : formatTime(dueAt)) : "No due date";

  return (
    <li className="flex items-start gap-3 border-b border-zinc-200 py-3 last:border-0 dark:border-zinc-800">
      <div className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-zinc-500 sm:w-24 sm:text-sm dark:text-zinc-400">
        {dueAt ? (
          <time dateTime={dueAt}>
            {showDay && <span className="block">{formatDay(dueAt)}</span>}
            {time}
          </time>
        ) : time}
      </div>

      <div className="min-w-0 flex-1">
        <a
          href={task.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="break-words font-medium hover:underline"
        >
          {task.title}
        </a>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{task.courseCode || task.courseName}</span>
          <KindBadge kind={task.kind} />
          <SourceBadge source={task.source} />
          {task.unconfirmed && (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              title={`Read from text, not a Canvas date: "${task.evidence ?? ""}"`}
            >
              unconfirmed
            </span>
          )}
          {task.pointsPossible !== null && <span>{task.pointsPossible} pts</span>}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={status} />
        {dueAt && !task.allDay && (
          <span className="text-[11px] text-zinc-400">
            {relativeDistance(dueAt, now)}
          </span>
        )}
      </div>
    </li>
  );
}

const ED_ORIGIN: string = ED_ORIGINS[0];

export default function App() {
  const { snapshot, loading, refreshing, refresh } = useSnapshot();
  const now = useNow();
  const { tasks, error, gradescopeError, edError, fetchedAt, user } = snapshot;
  const [courseKey, setCourseKey] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const courses = useMemo(() => {
    const names = new Map(snapshot.courses.filter((course) => !course.restricted)
      .map((course) => [workCourseKey("canvas", course.id), course.courseCode || course.name]));
    for (const task of tasks) {
      const key = workCourseKey(task.source, task.courseId);
      if (names.has(key)) continue;
      const name = task.courseCode || task.courseName;
      names.set(key, task.source === "gradescope" ? `${name} (Gradescope)` : name);
    }
    return [...names].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  }, [snapshot.courses, tasks]);
  const selectedCourse = courses.some(([key]) => key === courseKey) ? courseKey : null;
  // Dates typed in settings show at once, without waiting for the next sync.
  const [manual, setManual] = useState<ManualExams>({});
  useEffect(() => {
    void loadManualExams().then(setManual);
    const onChange = (changes: Record<string, unknown>) => { if (MANUAL_EXAMS_KEY in changes) void loadManualExams().then(setManual); };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  const exams = useMemo(
    () => examsByCourse(withManualExams(snapshot.exams ?? [], manual, snapshot.courses), snapshot.courses, now),
    [snapshot.exams, snapshot.courses, manual, now],
  );

  // `now` is in the dependency list so grouping headings re-derive when the
  // clock crosses midnight, not only when the data changes.
  const work = useMemo(
    () => upcomingWork(tasks, now, UPCOMING_DAYS, selectedCourse, showCompleted),
    [tasks, now, selectedCourse, showCompleted],
  );
  const groups = useMemo(() => groupByDay(work.upcoming), [work.upcoming]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Upcoming</h1>
            {(user || fetchedAt) && (
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {user?.name}
                {user && fetchedAt && " · "}
                {fetchedAt && <>Updated {relativeDistance(fetchedAt, now)}</>}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {error && (
          <div className="mb-6">
            <ErrorBanner error={error} canvasOrigin={DEFAULT_CANVAS_ORIGIN} />
          </div>
        )}

        {gradescopeError && (
          <div className="mb-6">
            <ErrorBanner error={gradescopeError} canvasOrigin={GRADESCOPE_ORIGIN} service="Gradescope" />
          </div>
        )}

        {edError && (
          <div className="mb-6">
            <ErrorBanner error={edError} canvasOrigin={ED_ORIGIN} service="Ed Discussion" />
          </div>
        )}

        {!loading && (
          <div className="mb-5 flex flex-wrap items-end gap-x-5 gap-y-3">
            <label className="grid min-w-0 max-w-full gap-1 text-sm font-medium">
              Course
              <select
                value={selectedCourse ?? ""}
                onChange={(event) => setCourseKey(event.target.value)}
                className="min-w-0 max-w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">All courses</option>
                {courses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 py-1.5 text-sm">
              <input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />
              Include submitted and graded
            </label>
          </div>
        )}

        {!loading && work.attention.length > 0 && (
          <section aria-labelledby="needs-attention" className="mb-7">
            <h2 id="needs-attention" className="mb-1 text-sm font-semibold">Needs attention</h2>
            <ul className="rounded-lg border border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
              {work.attention.map((task) => <TaskRow key={task.id} task={task} now={now} showDay />)}
            </ul>
          </section>
        )}

        {loading ? (
          <Spinner label="Loading your upcoming work…" />
        ) : (
          <section aria-labelledby="upcoming-window">
            <h2 id="upcoming-window" className="mb-3 text-sm font-semibold">Next {UPCOMING_DAYS} days</h2>
            {groups.length === 0 ? (
              <EmptyState>{showCompleted ? "Nothing" : "No open work"} due in this window.</EmptyState>
            ) : (
              <div className="space-y-6">
                {groups.map(([day, dayTasks]) => (
                  <section key={day}>
                    <h3 className="mb-1 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                      {dayTasks[0]?.dueAt ? relativeDay(dayTasks[0].dueAt, now) : day}
                    </h3>
                    <ul className="rounded-lg border border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
                      {dayTasks.map((task) => (
                        <TaskRow key={task.id} task={task} now={now} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </section>
        )}

        {!loading && (
          <section className="mt-10" aria-labelledby="all-exams">
            <h2 id="all-exams" className="mb-1 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              All exams
            </h2>
            {exams.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No exam dates found.</p>}
            <div className="space-y-4">
              {exams.map(({ course, exams: list }) => (
                <div key={course.id}>
                  <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                    {course.courseCode || course.name}
                  </h3>
                  {list.length === 0 ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">No exam dates found.</p>
                  ) : (
                    <ul className="rounded-lg border border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
                      {list.map((task) => (
                        <TaskRow key={task.id} task={task} now={now} showDay />
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="mt-10 text-xs text-zinc-400">
          All data stays on this machine. No account, no backend, nothing leaves
          your browser.
        </footer>
      </div>
    </div>
  );
}
