/**
 * The popup.
 *
 * An ordinary HTML page at a `chrome-extension://` URL, shown when the toolbar
 * icon is clicked. Its JavaScript context is created on open and destroyed on
 * close — so it does no fetching of its own, and keeps no state worth losing.
 * It asks the service worker for a snapshot and renders it.
 */

import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { taskStatus } from "@/src/lib/task-status";
import { relativeDay } from "@/src/lib/time";
import { EmptyState, ErrorBanner, Spinner } from "@/src/ui/components";
import { useSnapshot } from "@/src/ui/useSnapshot";

/** Open the full-page view in a normal tab. */
function openUpcoming() {
  // `getURL` resolves a packaged file to its chrome-extension:// address.
  void chrome.tabs.create({ url: chrome.runtime.getURL("upcoming.html") });
}

export default function App() {
  const { snapshot, loading, refreshing, refresh } = useSnapshot();
  const { user, courses, tasks, error } = snapshot;

  const dueSoon = tasks.filter((task) => {
    const status = taskStatus(task);
    return status === "due-soon" || status === "overdue" || status === "missing";
  });

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

      {error && (
        <div className="mb-3">
          <ErrorBanner error={error} canvasOrigin={DEFAULT_CANVAS_ORIGIN} />
        </div>
      )}

      {loading ? (
        <Spinner label="Loading your courses…" />
      ) : (
        <>
          {dueSoon.length > 0 && (
            <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <strong>{dueSoon.length}</strong>{" "}
              {dueSoon.length === 1 ? "item needs" : "items need"} attention
              {dueSoon[0]?.dueAt && <> — next {relativeDay(dueSoon[0].dueAt).toLowerCase()}</>}
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

          <button
            type="button"
            onClick={openUpcoming}
            className="mt-4 w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Upcoming — next 14 days ({tasks.length})
          </button>
        </>
      )}
    </div>
  );
}
