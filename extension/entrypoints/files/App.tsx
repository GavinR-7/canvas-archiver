/**
 * The Files page: pick a folder, review the plan, download.
 *
 * This runs as an extension page, not in the service worker, because
 * `showDirectoryPicker` needs a page and a click, and because a run writes
 * through a directory handle only a page can hold. Keep the tab open during a
 * run; a second run skips what is already on disk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { fetchCourseFiles, fetchCourseFolders, fetchCourseModules } from "@/src/files/api";
import {
  forgetRoot,
  loadRoot,
  pickRoot,
  requestRootAccess,
  rootAccess,
  saveRoot,
  type RootAccess,
} from "@/src/files/handle-store";
import { planCourses, summarize, type CoursePlan } from "@/src/files/plan";
import { looksBlockedByCors, runPlan, type RunResult } from "@/src/files/runner";
import { downloadsSink, folderSink } from "@/src/files/sinks";
import { EmptyState, ErrorBanner, Spinner } from "@/src/ui/components";
import { useSnapshot } from "@/src/ui/useSnapshot";

const button =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";
const linkButton = "text-sm underline underline-offset-2 hover:no-underline";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function App() {
  const { snapshot, loading } = useSnapshot();
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [access, setAccess] = useState<RootAccess>("prompt");
  const [chosen, setChosen] = useState<Set<number> | null>(null);
  const [plans, setPlans] = useState<CoursePlan[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await loadRoot();
      setRoot(saved);
      if (saved) setAccess(await rootAccess(saved));
    })();
  }, []);

  const courses = snapshot.courses.filter((c) => !c.restricted);
  const selected = chosen ?? new Set(courses.map((c) => c.id));

  const choose = useCallback(async () => {
    setProblem(null);
    try {
      const handle = await pickRoot();
      await saveRoot(handle);
      setRoot(handle);
      setAccess(await requestRootAccess(handle));
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setProblem(`Chrome would not use that folder: ${(error as Error).message}. Pick or create a subfolder such as Documents/School.`);
      }
    }
  }, []);

  const reconnect = useCallback(async () => {
    if (root) setAccess(await requestRootAccess(root));
  }, [root]);

  const buildPlan = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    setPlans(null);
    try {
      const inputs = [];
      for (const course of courses.filter((c) => selected.has(c.id))) {
        setStatus(`Reading ${course.courseCode || course.name}…`);
        const [modules, files, folders] = await Promise.all([
          fetchCourseModules(course.id),
          fetchCourseFiles(course.id),
          fetchCourseFolders(course.id),
        ]);
        inputs.push({ course, modules, files, folders });
      }
      setPlans(planCourses(inputs));
    } catch (error) {
      setProblem(`Could not read your courses from Canvas: ${(error as Error).message}`);
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }, [courses, selected]);

  const start = useCallback(
    async (useDownloads: boolean) => {
      if (!plans || (!useDownloads && !root)) return;
      setBusy(true);
      setProblem(null);
      setResult(null);
      abort.current = new AbortController();
      const files = plans.flatMap((p) => p.files);
      try {
        const sink = useDownloads ? downloadsSink() : folderSink(root as FileSystemDirectoryHandle);
        const outcome = await runPlan(files, sink, {
          signal: abort.current.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        setResult(outcome);
      } catch (error) {
        setProblem(String(error));
      } finally {
        setBusy(false);
      }
    },
    [plans, root],
  );

  const summary = plans ? summarize(plans) : null;
  const ready = root && access === "granted";

  return (
    <div className="mx-auto max-w-3xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Course files</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Saves your Canvas files into a folder you choose, as Cornell/&lt;course&gt;/&lt;module&gt;/. Read-only: nothing
        in Canvas changes, and nothing leaves this computer.
      </p>

      {snapshot.error && <div className="mt-4"><ErrorBanner error={snapshot.error} canvasOrigin={DEFAULT_CANVAS_ORIGIN} /></div>}
      {problem && <p role="alert" className="mt-4 rounded-lg border border-red-400/50 bg-red-500/10 p-3 text-sm">{problem}</p>}

      <section className="mt-6">
        <h2 className="font-medium">1. Folder</h2>
        {!root && (
          <>
            <p className="mt-1 text-sm text-zinc-500">Chrome will not let you pick Downloads, Documents or Desktop themselves; choose or create a folder inside one, e.g. Documents/School.</p>
            <button type="button" className={`${button} mt-2`} onClick={choose}>Choose folder</button>
          </>
        )}
        {root && (
          <p className="mt-1 text-sm">
            <strong>{root.name}</strong>{" "}
            {access === "granted" ? "· ready" : "· Chrome needs you to allow access again"}{" "}
            {access !== "granted" && <button type="button" className={linkButton} onClick={reconnect}>Reconnect folder</button>}{" "}
            <button type="button" className={linkButton} onClick={choose}>Change</button>{" "}
            <button type="button" className={linkButton} onClick={() => { void forgetRoot(); setRoot(null); }}>Forget</button>
          </p>
        )}
      </section>

      <section className="mt-6">
        <h2 className="font-medium">2. Courses</h2>
        {loading ? <Spinner label="Loading courses…" /> : courses.length === 0 ? (
          <EmptyState>No active courses found. Sign in to Canvas and reload.</EmptyState>
        ) : (
          <ul className="mt-2 space-y-1">
            {courses.map((course) => (
              <li key={course.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(course.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(course.id);
                      else next.delete(course.id);
                      setChosen(next);
                      setPlans(null);
                    }}
                  />
                  {course.courseCode} {course.name !== course.courseCode && course.name}
                  <span className="text-xs text-zinc-400">{course.term.code}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={`${button} mt-3`} disabled={busy || selected.size === 0} onClick={buildPlan}>
          Preview what will be saved
        </button>
        {status && <p className="mt-2 text-sm text-zinc-500">{status}</p>}
      </section>

      {plans && summary && (
        <section className="mt-6">
          <h2 className="font-medium">3. Review</h2>
          <p className="mt-1 text-sm">
            {summary.files} files, {formatBytes(summary.bytes)}, from {summary.courses} courses.
            {summary.skipped > 0 && ` ${summary.skipped} locked or unavailable files will be skipped.`}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
            {plans.map((plan) => (
              <li key={plan.courseId}>Cornell/{plan.folder}/ · {plan.files.length} files</li>
            ))}
          </ul>
          <button type="button" className={`${button} mt-3`} disabled={busy || !ready || summary.files === 0} onClick={() => start(false)}>
            Save to {root?.name ?? "folder"}
          </button>
          {!ready && <p className="mt-1 text-sm text-zinc-500">Choose (or reconnect) a folder first.</p>}
          {busy && <button type="button" className={`${linkButton} ml-3`} onClick={() => abort.current?.abort()}>Stop</button>}
          {progress && busy && <p className="mt-2 text-sm tabular-nums">{progress.done} / {progress.total}</p>}
        </section>
      )}

      {result && (
        <section className="mt-6" aria-live="polite">
          <h2 className="font-medium">Done</h2>
          <p className="mt-1 text-sm">
            {result.saved} saved, {result.skipped} already there, {result.failed} failed{result.cancelled && " (stopped early)"}.
          </p>
          {looksBlockedByCors(result) && (
            <div className="mt-2 rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
              <p>Chrome could not read the files directly, so your chosen folder cannot be used for this Canvas. You can still save them under your Downloads folder as Cornell/…:</p>
              <button type="button" className={`${button} mt-2`} onClick={() => start(true)}>Save to Downloads instead</button>
            </div>
          )}
          {result.failed > 0 && (
            <ul className="mt-2 max-h-48 overflow-auto text-xs text-zinc-500">
              {result.outcomes.filter((o) => o.status === "failed").slice(0, 50).map((o) => (
                <li key={o.fileId}>{o.path.join("/")} — {o.status === "failed" && o.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
