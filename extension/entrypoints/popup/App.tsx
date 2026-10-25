/**
 * The popup.
 *
 * An ordinary HTML page at a `chrome-extension://` URL, shown when the toolbar
 * icon is clicked. Its JavaScript context is created on open and destroyed on
 * close — so it does no fetching of its own, and keeps no state worth losing.
 * It asks the service worker for a snapshot and renders it.
 */

import { useEffect, useState } from "react";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { GRADESCOPE_ORIGIN } from "@/src/config/gradescope";
import { OPEN_CANVAS_PROMPT, canvasTabIsActive } from "@/src/lib/canvas-tab";
import { taskStatus } from "@/src/lib/task-status";
import { describeDue } from "@/src/lib/time";
import { EmptyState, ErrorBanner, ShowAllCourses, Spinner } from "@/src/ui/components";
import { useCourseFilter } from "@/src/ui/useCourseFilter";
import { useNow } from "@/src/ui/useNow";
import { useSnapshot } from "@/src/ui/useSnapshot";

/** Open the full-page view in a normal tab. */
function openUpcoming() {
  // `getURL` resolves a packaged file to its chrome-extension:// address.
  void chrome.tabs.create({ url: chrome.runtime.getURL("upcoming.html") });
}

function openChat() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("chat.html") });
}

function openSchedule() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("schedule.html") });
}

function openBrowse() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("browse.html") });
}

function openCanvas() {
  void chrome.tabs.create({ url: DEFAULT_CANVAS_ORIGIN });
}

function openFiles() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("files.html") });
}

export default function App() {
  const { snapshot, loading, refreshing, refresh } = useSnapshot();
  const now = useNow();
  const { user, tasks, error, gradescopeError } = snapshot;
  const filter = useCourseFilter("popup", snapshot.courses);
  const courses = filter.courses;
  // null until known, so the prompt does not flash on a Canvas tab. The popup works from anywhere; this only says where syncing starts.
  const [onCanvas, setOnCanvas] = useState<boolean | null>(null);
  useEffect(() => {
    void canvasTabIsActive().then(setOnCanvas);
  }, []);

  const needsAttention = tasks.filter((task) => {
    const status = taskStatus(task, now);
    return status === "due-soon" || status === "overdue" || status === "missing";
  });

  // The *soonest upcoming* item, which is not the same as the first item that
  // needs attention: `missing` has no time bound, so the ascending sort puts
  // the oldest overdue thing first. Calling that one "next" was backwards.
  const nextUp = tasks.find(
    (task) => task.dueAt !== null && new Date(task.dueAt).getTime() >= now.getTime(),
  );

  return (
    <div className="w-[360px] bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Canvas Archiver</h1>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {user ? `Signed in as ${user.name}` : "Not signed in"}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {onCanvas === false && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs dark:bg-zinc-800">
          <span>{OPEN_CANVAS_PROMPT}</span>
          <button
            type="button"
            onClick={openCanvas}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 font-medium hover:bg-white dark:border-zinc-600 dark:hover:bg-zinc-700"
          >
            Open Canvas
          </button>
        </div>
      )}

      {error && (
        <div className="mb-3">
          <ErrorBanner error={error} canvasOrigin={DEFAULT_CANVAS_ORIGIN} />
        </div>
      )}

      {gradescopeError && (
        <div className="mb-3">
          <ErrorBanner error={gradescopeError} canvasOrigin={GRADESCOPE_ORIGIN} service="Gradescope" />
        </div>
      )}

      {loading ? (
        <Spinner label="Loading your courses…" />
      ) : (
        <>
          {needsAttention.length > 0 && (
            <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <strong>{needsAttention.length}</strong>{" "}
              {needsAttention.length === 1 ? "item needs" : "items need"} attention
              {nextUp?.dueAt && <> · {describeDue(nextUp.dueAt, now)}</>}
            </p>
          )}

          <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Active courses ({courses.length})
          </h2>

          {courses.length === 0 ? (
            <EmptyState>No active courses found.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {courses.map((course) => (
                <li key={course.id}>
                  <a
                    href={course.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {course.name}
                      </span>
                      {course.courseCode && (
                        <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {course.courseCode}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-400">
                      {course.term.code}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <ShowAllCourses hiddenCount={filter.hidden.length} showAll={filter.showAll} onToggle={filter.toggle} />

          <button
            type="button"
            onClick={openUpcoming}
            className="mt-4 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Upcoming — next 14 days ({tasks.length})
          </button>
          <button
            type="button"
            onClick={openFiles}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Save course files…
          </button>
          <button
            type="button"
            onClick={openBrowse}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Browse a class's files…
          </button>
          <button
            type="button"
            onClick={openChat}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Course chat…
          </button>
          <button
            type="button"
            onClick={openSchedule}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Week schedule…
          </button>
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            className="mt-2 w-full text-center text-xs text-zinc-500 underline underline-offset-2 hover:no-underline"
          >
            Settings (send deadlines to HQ)
          </button>
        </>
      )}
    </div>
  );
}
