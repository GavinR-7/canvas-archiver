/**
 * "Get everything for…": describe what you are studying for, review the files
 * chosen, copy them into one folder. Rules first (module names, syllabus
 * coverage); the model, with your own key, only when the rules find nothing.
 */

import { useMemo, useState } from "react";
import { askModel, loadAi } from "@/src/ai/model";
import { candidatesFromPlan, coverageFromSyllabus, namesExam, parseRequest, pickFiles, type Candidate } from "@/src/ai/pick";
import { courseKey } from "@/src/dates/merge";
import { fetchCourseSources } from "@/src/files/api";
import { archiveLayout } from "@/src/files/layout";
import { sanitizeSegment, uniqueNames } from "@/src/files/paths";
import { planCourse, type CoursePlan, type CourseSources } from "@/src/files/plan";
import { runArchive } from "@/src/files/runner";
import { folderSink } from "@/src/files/sinks";
import type { Course, Task } from "@/src/types/canvas";

interface Chosen {
  id: string;
  title: string;
  reason: string;
  on: boolean;
}

const button =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

interface Props {
  courses: Course[];
  tasks: Task[];
  root: FileSystemDirectoryHandle | null;
  ready: boolean;
}

export default function Picker({ courses, tasks, root, ready }: Props) {
  const [courseId, setCourseId] = useState<number | null>(null);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Chosen[] | null>(null);
  const [plan, setPlan] = useState<CoursePlan | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const course = courses.find((c) => c.id === (courseId ?? courses[0]?.id)) ?? null;
  const exams = useMemo(
    () =>
      tasks
        .filter((t) => t.kind === "exam" && course && courseKey(t.courseCode) === courseKey(course.courseCode))
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "")),
    [tasks, course],
  );

  const find = async () => {
    if (!course || !request.trim()) return;
    setBusy(true);
    setNote(null);
    setDone(null);
    setChosen(null);
    try {
      const sources: CourseSources = await fetchCourseSources(course.id);
      const coursePlan = planCourse(course, sources);
      const candidates = candidatesFromPlan(coursePlan);
      const parsed = parseRequest(request);
      const syllabus = sources.documents.find((d) => d.kind === "syllabus");
      const syllabusRanges = parsed.exam && syllabus ? coverageFromSyllabus(syllabus.html, parsed.exam) : [];

      // The window: this exam's date and the previous exam's, from the dates feed.
      let window = null;
      if (parsed.exam) {
        const same = exams.filter((e) => namesExam(e.title, { word: parsed.exam?.word ?? "exam", n: null }));
        const idx = same.findIndex((e) => parsed.exam?.n !== null && new RegExp(`\\b${parsed.exam?.n}\\b`).test(e.title));
        const target = idx >= 0 ? same[idx] : undefined;
        if (target?.dueAt) window = { after: same[idx - 1]?.dueAt ?? null, until: target.dueAt };
      }

      const rules = pickFiles({ request, candidates, syllabusRanges, window });
      const byId = new Map(candidates.map((c) => [c.id, c]));
      let rows: Chosen[] = rules.picked.map((p) => ({ id: p.id, title: label(byId.get(p.id)), reason: p.reasons[0] as string, on: true }));

      if (rules.needsModel) {
        const ai = await loadAi();
        if (!ai.enabled || !ai.apiKey) {
          setNote("No file names matched that request. Add your own API key in Settings to let a model choose from the file names, or try wording like \"weeks 3-6\".");
        } else {
          setNote("Nothing matched by name, so a model chose from the file names (names only leave this computer, never file contents).");
          const picks = await askModel(
            ai,
            { request, course: course.courseCode || course.name, exams: exams.map((e) => `${e.title}: ${e.dueAt?.slice(0, 10) ?? "undated"}`) },
            candidates,
          );
          rows = picks.map((p) => ({ id: p.id, title: label(byId.get(p.id)), reason: p.reason, on: true }));
        }
      }
      setPlan(coursePlan);
      setChosen(rows);
      if (rows.length === 0 && !rules.needsModel) setNote("Nothing matched.");
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!plan || !chosen || !root || !course) return;
    setBusy(true);
    setDone(null);
    try {
      const keep = new Set(chosen.filter((c) => c.on).map((c) => c.id));
      const items = plan.items.filter((i) => keep.has(i.source));
      const folder = sanitizeSegment(`${request.trim()} - ${course.courseCode || course.name}`, "Study folder");
      // One flat folder: the module name prefixes each file so the order survives.
      const names = uniqueNames(
        items.map((i) => {
          const below = i.path.slice(plan.dir.length);
          return below.length > 1 ? `${below[0]} - ${below[below.length - 1]}` : (below[0] as string);
        }),
      );
      const flat: CoursePlan = {
        ...plan,
        dir: [folder],
        items: items.map((item, n) => ({ ...item, path: [folder, names[n] as string] })),
        skipped: [],
      };
      const result = await runArchive([flat], archiveLayout, folderSink(root), null);
      setDone(`${result.saved} copied to ${root.name}/${folder}/${result.failed ? `, ${result.failed} failed` : ""}.`);
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (courses.length === 0) return null;
  return (
    <section className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-700">
      <h2 className="font-medium">Get everything for…</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Say what you are studying for, like "prelim 2" or "weeks 3-6". You review the list, then it is copied into one folder.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <select
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600"
          value={course?.id ?? ""}
          onChange={(e) => { setCourseId(Number(e.target.value)); setChosen(null); }}
        >
          {courses.map((c) => <option key={c.id} value={c.id}>{c.courseCode || c.name}</option>)}
        </select>
        <input
          className="min-w-48 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600"
          placeholder="prelim 2"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
        <button type="button" className={button} disabled={busy || !request.trim()} onClick={find}>Find files</button>
      </div>
      {exams.length > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          Known exams:{" "}
          {exams.map((e) => (
            <button key={e.id} type="button" className="mr-2 underline" onClick={() => setRequest(e.title.replace(/\s*\(.*$/, ""))}>{e.title}</button>
          ))}
        </p>
      )}
      {note && <p className="mt-2 text-sm">{note}</p>}
      {chosen && chosen.length > 0 && (
        <>
          <ul className="mt-3 space-y-1 text-sm">
            {chosen.map((c, i) => (
              <li key={c.id}>
                <label className="flex gap-2">
                  <input type="checkbox" checked={c.on} onChange={(e) => setChosen(chosen.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                  <span>{c.title} <span className="text-xs text-zinc-500">— {c.reason}</span></span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className={`${button} mt-3`} disabled={busy || !ready || !chosen.some((c) => c.on)} onClick={copy}>
            Copy {chosen.filter((c) => c.on).length} files to one folder
          </button>
          {!ready && <p className="mt-1 text-sm text-zinc-500">Choose (or reconnect) a folder in step 1 first.</p>}
        </>
      )}
      {done && <p className="mt-2 text-sm" aria-live="polite">{done}</p>}
    </section>
  );
}

const label = (c: Candidate | undefined) => (c ? (c.group ? `${c.group} / ${c.title}` : c.title) : "(unknown)");
