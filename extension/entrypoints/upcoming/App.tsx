/**
 * The "Upcoming" extension page.
 *
 * An extension page is just an HTML file the extension ships, opened in a
 * normal tab via `chrome.tabs.create({ url: chrome.runtime.getURL(...) })`. It
 * has the same origin and permissions as the popup, but a full tab's worth of
 * room and a lifetime that does not end when focus moves elsewhere.
 *
 * Everything due in the next 14 days, across every course, sorted by due date
 * and grouped by local calendar day.
 */

import { useMemo } from "react";
import { UPCOMING_DAYS } from "@/src/canvas/api";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { taskStatus } from "@/src/lib/task-status";
import { formatTime, localDayKey, relativeDay, relativeDistance } from "@/src/lib/time";
import { useNow } from "@/src/ui/useNow";
import type { Task } from "@/src/types/canvas";
import { EmptyState, ErrorBanner, KindBadge, Spinner, StatusBadge } from "@/src/ui/components";
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

function TaskRow({ task, now }: { task: Task; now: Date }) {
  const status = taskStatus(task, now);

  return (
    <li className="flex items-start gap-3 border-b border-zinc-200 py-3 last:border-0 dark:border-zinc-800">
      <time
        className="w-20 shrink-0 pt-0.5 text-sm tabular-nums text-zinc-500 dark:text-zinc-400"
        dateTime={task.dueAt ?? undefined}
      >
        {task.dueAt ? formatTime(task.dueAt) : "—"}
      </time>

      <div className="min-w-0 flex-1">
        <a
          href={task.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium hover:underline"
        >
          {task.title}
        </a>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{task.courseCode || task.courseName}</span>
          <KindBadge kind={task.kind} />
          {task.pointsPossible !== null && <span>{task.pointsPossible} pts</span>}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={status} />
        {task.dueAt && (
          <span className="text-[11px] text-zinc-400">
            {relativeDistance(task.dueAt, now)}
          </span>
        )}
      </div>
    </li>
  );
}

export default function App() {
  const { snapshot, loading, refreshing, refresh } = useSnapshot();
  const now = useNow();
  const { tasks, error, fetchedAt, user } = snapshot;

  // `now` is in the dependency list so grouping headings re-derive when the
  // clock crosses midnight, not only when the data changes.
  const groups = useMemo(() => groupByDay(tasks), [tasks, now]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Upcoming</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Next {UPCOMING_DAYS} days
              {user && <> · {user.name}</>}
              {fetchedAt && (
                <> · updated {relativeDistance(fetchedAt, now)}</>
              )}
            </p>
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

        {loading ? (
          <Spinner label="Loading your upcoming work…" />
        ) : groups.length === 0 ? (
          <EmptyState>
            Nothing due in the next {UPCOMING_DAYS} days.
            {!error && " Enjoy it."}
          </EmptyState>
        ) : (
          <div className="space-y-6">
            {groups.map(([day, dayTasks]) => (
              <section key={day}>
                <h2 className="mb-1 text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                  {dayTasks[0]?.dueAt ? relativeDay(dayTasks[0].dueAt, now) : day}
                </h2>
                <ul className="rounded-lg border border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
                  {dayTasks.map((task) => (
                    <TaskRow key={task.id} task={task} now={now} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <footer className="mt-10 text-xs text-zinc-400">
          All data stays on this machine. No account, no backend, nothing leaves
          your browser.
        </footer>
      </div>
    </div>
  );
}
