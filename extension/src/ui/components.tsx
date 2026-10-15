/**
 * Shared presentational pieces.
 *
 * Deliberately unstyled beyond Tailwind utilities and deliberately dumb: they
 * take data and render it, with no knowledge of Canvas or messaging.
 */

import type { ReactNode } from "react";
import type { Task, TaskStatus } from "@/src/types/canvas";
import type { SnapshotError } from "@/src/lib/messages";

const STATUS_STYLES: Record<TaskStatus, { label: string; className: string }> = {
  graded: { label: "Graded", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  submitted: { label: "Submitted", className: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  missing: { label: "Missing", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  overdue: { label: "Overdue", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  "due-soon": { label: "Due soon", className: "bg-amber-500/20 text-amber-800 dark:text-amber-300" },
  upcoming: { label: "Upcoming", className: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300" },
  locked: { label: "Locked", className: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300" },
  "no-due-date": { label: "No due date", className: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

/** Shown only for sources other than Canvas, which is the unmarked default. */
export function SourceBadge({ source }: { source: Task["source"] }) {
  if (source === "canvas") return null;
  const label = { gradescope: "Gradescope", ed: "Ed", syllabus: "Syllabus" }[source];
  return (
    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
      {label}
    </span>
  );
}

const KIND_LABELS: Record<Task["kind"], string> = {
  assignment: "Assignment",
  quiz: "Quiz",
  discussion: "Discussion",
  exam: "Exam",
};

export function KindBadge({ kind }: { kind: Task["kind"] }) {
  return (
    <span className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
      {KIND_LABELS[kind]}
    </span>
  );
}

/**
 * Error banner.
 *
 * A session expiry is not really an error so much as an instruction, so it
 * gets a link to Canvas rather than a red box and an apology.
 */
export function ErrorBanner({
  error,
  canvasOrigin,
  service = "Canvas",
}: {
  error: SnapshotError;
  /** Where "sign in" should send the user. Named for Canvas, used for both. */
  canvasOrigin: string;
  service?: "Canvas" | "Gradescope" | "Ed Discussion";
}) {
  const expired = error.kind === "session-expired";

  return (
    <div
      role="alert"
      className={`rounded-lg border p-3 text-sm ${
        expired
          ? "border-amber-400/50 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-red-400/50 bg-red-500/10 text-red-900 dark:text-red-200"
      }`}
    >
      <p className="font-medium">
        {expired ? `You're signed out of ${service}` : `Couldn't reach ${service}`}
      </p>
      <p className="mt-1 opacity-90">{error.message}</p>
      {expired && (
        <a
          href={canvasOrigin}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block font-medium underline underline-offset-2"
        >
          Open {service} and sign in →
        </a>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
      <span
        aria-hidden
        className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      {label}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </div>
  );
}
