/**
 * Course browser: click a class, see its files as folders, tick the ones you
 * want, download just those.
 *
 * It plans the course exactly as the full archive does (same folders, same
 * manifest), so a ticked item lands where the archive would put it and is
 * skipped when it is already saved and unchanged. Ticks are remembered per
 * course. Canvas files, plus the class's Gradescope handouts when they load; read-only; the same folder and permissions as Files.
 */

import { describeRun } from "@/src/files/summary";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import { fetchCourseSources } from "@/src/files/api";
import { fetchGradescopeFiles, LISTING_BUDGET_MS } from "@/src/gradescope/api";
import { handoutsFor, matchCanvasCourse } from "@/src/gradescope/files";
import {
  buildTree,
  loadSelection,
  pruneSelection,
  savedSources,
  downloadsSources,
  saveSelection,
  setFolder,
  subsetPlan,
  tickOf,
  type FolderNode,
} from "@/src/files/browse";
import { loadDirBindings, rememberDirBindings } from "@/src/files/dirs";
import { loadRoot, requestRootAccess, rootAccess, type RootAccess } from "@/src/files/handle-store";
import { archiveLayout } from "@/src/files/layout";
import { planCourses, type CoursePlan } from "@/src/files/plan";
import { IN_DOWNLOADS, looksBlockedByCors, runArchive, type RunResult } from "@/src/files/runner";
import { downloadsSink, folderManifestStore, folderSink } from "@/src/files/sinks";
import { EmptyState, ErrorBanner, ShowAllCourses, Spinner } from "@/src/ui/components";
import { useCourseFilter } from "@/src/ui/useCourseFilter";
import { useSnapshot } from "@/src/ui/useSnapshot";
import type { Course } from "@/src/types/canvas";

const button =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";
const linkButton = "text-sm underline underline-offset-2 hover:no-underline";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");

function Tick({ state, label, onChange }: { state: "none" | "some" | "all"; label: string; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === "all"} onChange={(e) => onChange(e.target.checked)} />;
}

function Folder({
  node,
  selected,
  saved,
  inDownloads,
  onSelect,
  depth,
}: {
  node: FolderNode;
  selected: ReadonlySet<string>;
  saved: ReadonlySet<string>;
  inDownloads: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  depth: number;
}) {
  const toggleFile = (source: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(source);
    else next.delete(source);
    onSelect(next);
  };
  return (
    <ul className={depth === 0 ? "space-y-1" : "ml-5 mt-1 space-y-1"}>
      {node.folders.map((folder) => (
        <li key={folder.path.join("/")}>
          <details>
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <Tick state={tickOf(folder, selected)} label={`Select ${folder.name}`} onChange={(on) => onSelect(setFolder(selected, folder, on))} />
              {folder.name}
            </summary>
            <Folder node={folder} selected={selected} saved={saved} inDownloads={inDownloads} onSelect={onSelect} depth={depth + 1} />
          </details>
        </li>
      ))}
      {node.files.map((file) => (
        <li key={file.item.source}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.has(file.item.source)} onChange={(e) => toggleFile(file.item.source, e.target.checked)} />
            <span>{file.name}</span>
            <span className="text-xs text-zinc-500">
              {file.item.size > 0 && formatBytes(file.item.size)} {formatDate(file.item.modifiedAt)}
            </span>
            {saved.has(file.item.source) && <span className="text-xs text-zinc-500">saved</span>}
            {inDownloads.has(file.item.source) && <span className="text-xs text-zinc-500">in Downloads, not the archive folder</span>}
          </label>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const { snapshot, loading } = useSnapshot();
  const allCourses = useMemo(() => snapshot.courses.filter((c) => !c.restricted), [snapshot.courses]);
  const filter = useCourseFilter("files", allCourses);

  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [access, setAccess] = useState<RootAccess>("prompt");
  const [course, setCourse] = useState<Course | null>(null);
  const [plan, setPlan] = useState<CoursePlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [inDownloads, setInDownloads] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const openGeneration = useRef(0);

  useEffect(() => {
    void (async () => {
      const handle = await loadRoot();
      setRoot(handle);
      if (handle) setAccess(await rootAccess(handle));
    })();
  }, []);

  const open = useCallback(
    async (next: Course) => {
      setCourse(next);
      setPlan(null);
      setResult(null);
      setProblem(null);
      setReading(true);
      const generation = ++openGeneration.current;
      try {
        const sources = await fetchCourseSources(next.id);
        const bound = await loadDirBindings(archiveLayout.id);
        const show = async (built: CoursePlan) => {
          setPlan(built);
          setSelected(pruneSelection(await loadSelection(next.id), built));
          setSaved(new Set());
          setInDownloads(new Set());
          if (root && access === "granted") {
            try {
              const manifest = await folderManifestStore(folderSink(root)).load(built);
              setSaved(savedSources(built, manifest));
              setInDownloads(downloadsSources(built, manifest));
            } catch {
              // No readable manifest (new folder, or another course's): nothing is marked saved.
            }
          }
        };
        await show(planCourses([{ course: next, sources }], archiveLayout, bound)[0] as CoursePlan);
        // Gradescope handouts join the same tree when they arrive. Optional: a hang or a failure never holds up Canvas files.
        void fetchGradescopeFiles(new Date(), undefined, LISTING_BUDGET_MS, (g) => matchCanvasCourse(g, allCourses)?.id === next.id).then(async (listing) => {
          if (generation !== openGeneration.current) return; // another class was opened meanwhile
          const external = handoutsFor(listing, next, allCourses);
          if (external.length === 0) return;
          await show(planCourses([{ course: next, sources: { ...sources, external } }], archiveLayout, bound)[0] as CoursePlan);
        });
      } catch (error) {
        setProblem(`Could not read this course from Canvas: ${(error as Error).message}`);
      } finally {
        setReading(false);
      }
    },
    [root, access, allCourses],
  );

  const select = useCallback(
    (next: Set<string>) => {
      setSelected(next);
      if (course) void saveSelection(course.id, next);
    },
    [course],
  );

  const tree = useMemo(() => (plan ? buildTree(plan) : null), [plan]);
  const chosenPlan = plan ? subsetPlan(plan, selected) : null;
  const chosenBytes = chosenPlan?.items.reduce((n, i) => n + i.size, 0) ?? 0;
  const ready = root !== null && access === "granted";

  const download = useCallback(
    async (useDownloads: boolean) => {
      if (!chosenPlan || chosenPlan.items.length === 0 || (!useDownloads && !root)) return;
      setBusy(true);
      setProblem(null);
      setResult(null);
      setProgress(null);
      abort.current = new AbortController();
      try {
        const sink = useDownloads ? downloadsSink() : folderSink(root as FileSystemDirectoryHandle, { downloadsFallback: true });
        await rememberDirBindings(archiveLayout.id, [chosenPlan]);
        const outcome = await runArchive([chosenPlan], archiveLayout, sink, folderManifestStore(sink), {
          signal: abort.current.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        setResult(outcome);
        const here = (o: (typeof outcome.outcomes)[number]) => o.status !== "failed" && o.inDownloads === undefined;
        setSaved((previous) => new Set([...previous, ...outcome.outcomes.filter(here).map((o) => o.source)]));
        setInDownloads((previous) => new Set([...previous, ...outcome.outcomes.filter((o) => o.status !== "failed" && o.inDownloads !== undefined).map((o) => o.source)]));
      } catch (error) {
        setProblem(String(error));
      } finally {
        setBusy(false);
      }
    },
    [chosenPlan, root],
  );

  return (
    <div className="mx-auto max-w-3xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Course browser</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Click a class, tick the files you want, download just those. Read-only: nothing in Canvas changes. Files already saved and unchanged are skipped.
        {" "}
        {root ? (
          <>
            Saving to <strong>{root.name}</strong>
            {access !== "granted" && (
              <>
                {" "}
                <button type="button" className={linkButton} onClick={async () => setAccess(await requestRootAccess(root))}>Reconnect folder</button>
              </>
            )}
            .
          </>
        ) : (
          <>Choose a folder on the Course files page first.</>
        )}
      </p>

      {snapshot.error && <div className="mt-4"><ErrorBanner error={snapshot.error} canvasOrigin={DEFAULT_CANVAS_ORIGIN} /></div>}
      {problem && <p role="alert" className="mt-4 rounded-lg border border-red-400/50 bg-red-500/10 p-3 text-sm">{problem}</p>}

      <section className="mt-6">
        <h2 className="font-medium">Classes</h2>
        {loading ? <Spinner label="Loading courses…" /> : filter.courses.length === 0 ? (
          <EmptyState>No active courses found. Sign in to Canvas and reload.</EmptyState>
        ) : (
          <ul className="mt-2 space-y-1">
            {filter.courses.map((c) => (
              <li key={c.id}>
                <button type="button" className={`${linkButton} ${course?.id === c.id ? "font-semibold" : ""}`} disabled={reading || busy} onClick={() => void open(c)}>
                  {c.courseCode} {c.name !== c.courseCode && c.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <ShowAllCourses hiddenCount={filter.hidden.length} showAll={filter.showAll} onToggle={filter.toggle} />
      </section>

      {course && (
        <section className="mt-6">
          <h2 className="font-medium">{course.courseCode || course.name}</h2>
          {reading && <Spinner label="Reading the course…" />}
          {tree && plan && (
            <>
              {plan.items.length === 0 ? (
                <EmptyState>No files found in this course.</EmptyState>
              ) : (
                <div className="mt-2">
                  <Folder node={tree} selected={selected} saved={saved} inDownloads={inDownloads} onSelect={select} depth={0} />
                </div>
              )}
              {plan.skipped.length > 0 && <p className="mt-2 text-xs text-zinc-500">{plan.skipped.length} locked or unavailable files are not listed.</p>}
              <p className="mt-3 text-sm">
                {selected.size > 0 ? `${chosenPlan?.items.length ?? 0} ticked, ${formatBytes(chosenBytes)}.` : "Nothing ticked."}
                {selected.size > 0 && (
                  <>
                    {" "}
                    <button type="button" className={linkButton} onClick={() => select(new Set())}>Clear</button>
                  </>
                )}
              </p>
              <button type="button" className={`${button} mt-2`} disabled={busy || !ready || selected.size === 0} onClick={() => void download(false)}>
                Download ticked
              </button>
              {!ready && <p className="mt-1 text-sm text-zinc-500">Choose (or reconnect) a folder first.</p>}
              {busy && <button type="button" className={`${linkButton} ml-3`} onClick={() => abort.current?.abort()}>Stop</button>}
              {progress && busy && <p className="mt-2 text-sm tabular-nums">{progress.done} / {progress.total}</p>}
            </>
          )}
        </section>
      )}

      {result && (
        <section className="mt-6" aria-live="polite">
          <h2 className="font-medium">Done</h2>
          <p className="mt-1 text-sm">
            {describeRun(result)}.{result.viaDownloads + result.alreadyInDownloads > 0 && ` ${result.viaDownloads + result.alreadyInDownloads} are in the browser's Downloads folder, not in the archive folder (their file host refused a direct read); the lines below list them.`}
          </p>
          {looksBlockedByCors(result) && (
            <div className="mt-2 rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
              <p>Chrome could not read the files directly, so your chosen folder cannot be used for this Canvas. You can still save the ticked files under your Downloads folder:</p>
              <button type="button" className={`${button} mt-2`} onClick={() => void download(true)}>Save to Downloads instead</button>
            </div>
          )}
          {result.failed + result.viaDownloads + result.alreadyInDownloads > 0 && (
            <ul className="mt-2 max-h-48 overflow-auto text-xs text-zinc-500">
              {result.outcomes.filter((o) => o.status !== "failed" && o.inDownloads !== undefined).slice(0, 50).map((o) => (
                <li key={o.source}>{o.path.join("/")} — {IN_DOWNLOADS}: Downloads/{o.inDownloads}</li>
              ))}
              {result.outcomes.filter((o) => o.status === "failed").slice(0, 50).map((o) => (
                <li key={o.source}>{o.path.join("/")} — {o.status === "failed" && o.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
