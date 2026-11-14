/**
 * The popup's "Next 7 days" list.
 *
 * Presentational: the caller has already chosen which tasks fit the window.
 * A row links to the assignment itself; the Upcoming page is for the rest.
 */

import type { Task } from "@/src/types/canvas";
import { taskStatus } from "@/src/lib/task-status";
import { formatTime, relativeDay } from "@/src/lib/time";
import { SourceBadge, StatusBadge } from "@/src/ui/components";

export function PopupAgenda({
  tasks,
  now,
  hidden,
}: {
  tasks: readonly Task[];
  now: Date;
  hidden: number;
}) {
  if (tasks.length === 0) return null;

  return (
    <section className="mb-3" aria-label="Next 7 days">
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Next 7 days
      </h2>
      <ul className="space-y-0.5">
        {tasks.map((task) => {
          const status = taskStatus(task, now);
          return (
            <li key={task.id}>
              <a
                href={task.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <time
                  className="w-16 shrink-0 pt-0.5 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400"
                  dateTime={task.dueAt ?? undefined}
                >
                  {task.dueAt ? formatTime(task.dueAt) : "—"}
                </time>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{task.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="truncate">{task.courseCode || task.courseName}</span>
                    {task.dueAt && <span>{relativeDay(task.dueAt, now)}</span>}
                    <SourceBadge source={task.source} />
                  </span>
                </span>
                <span className="shrink-0 pt-0.5">
                  <StatusBadge status={status} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <p className="mt-1 px-2 text-[11px] text-zinc-400">
          {hidden} more in the next 7 days
        </p>
      )}
    </section>
  );
}
