/**
 * Course chat: ask questions or request a review guide, answered only from the
 * course's own text, with citations you can check.
 *
 * Retrieval is local (src/chat/retrieve). Only the few passages found for a
 * question are sent, with the user's own key, and only after a separate opt-in
 * in Settings. Covers what Canvas returns as text (pages, assignments,
 * announcements, syllabus); PDFs and slides are not read yet, and the page says so.
 */

import { CHAT_OPT_IN_TEXT, isAllowed, loadAllowed, setCourseAllowed } from "@/src/chat/optin";
import { useEffect, useMemo, useState } from "react";
import { complete, loadAi, MODEL } from "@/src/ai/model";
import { fetchCourseSources } from "@/src/files/api";
import { archiveLayout } from "@/src/files/layout";
import { planCourse } from "@/src/files/plan";
import { chatMode, findPassages, type FoundPassage } from "@/src/chat/find";
import { buildUser, citationsIn, SYSTEM, type Citation } from "@/src/chat/prompt";
import { buildIndex, chunkDoc, search, type Chunk, type Hit, type Index } from "@/src/chat/retrieve";
import { ShowAllCourses } from "@/src/ui/components";
import { useCourseFilter } from "@/src/ui/useCourseFilter";
import { useSnapshot } from "@/src/ui/useSnapshot";

interface Turn {
  question: string;
  answer: string;
  cited: Citation[];
  invalid: number[];
  /** Set for "Find (no AI)" turns: the passages themselves, with their citations. */
  found?: FoundPassage[];
}

const button =
  "rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

export default function App() {
  const { snapshot } = useSnapshot();
  const unrestricted = useMemo(() => snapshot.courses.filter((c) => !c.restricted), [snapshot.courses]);
  const filter = useCourseFilter("chat", unrestricted);
  const courses = filter.courses;
  const [courseId, setCourseId] = useState<number | null>(null);
  const course = courses.find((c) => c.id === courseId) ?? courses[0] ?? null;
  const [index, setIndex] = useState<{ courseId: number; index: Index; docs: number; files: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<number[]>([]);
  useEffect(() => { void loadAllowed().then(setAllowed); }, []);
  const courseAllowed = course ? isAllowed(allowed, course.id) : false;
  const allow = async (on: boolean) => {
    if (!course) return;
    await setCourseAllowed(course.id, on);
    setAllowed(await loadAllowed());
  };
  const courseLabel = course ? course.courseCode || course.name : "";

  const exams = useMemo(
    () => snapshot.tasks.filter((t) => t.kind === "exam" && course && t.courseCode.replace(/\W/g, "").toLowerCase() === course.courseCode.replace(/\W/g, "").toLowerCase()),
    [snapshot.tasks, course],
  );

  const load = async () => {
    if (!course) return;
    setBusy(true);
    setNote("Reading the course text from Canvas…");
    try {
      const sources = await fetchCourseSources(course.id);
      const plan = planCourse(course, sources, archiveLayout);
      const byId = new Map(plan.items.map((i) => [i.source, i]));
      const chunks: Chunk[] = [];
      for (const doc of sources.documents) {
        const item = byId.get(`canvas:${doc.kind}/${doc.key}`);
        const path = item ? item.path.slice(plan.dir.length).join("/") : doc.title;
        chunks.push(...chunkDoc({ source: `canvas:${doc.kind}/${doc.key}`, path, html: doc.html }));
      }
      setIndex({ courseId: course.id, index: buildIndex(chunks), docs: sources.documents.length, files: sources.files.length });
      setNote(null);
    } catch (error) {
      setNote(`Could not read the course: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const ask = async (text: string) => {
    if (!course || !index || index.courseId !== course.id || !text.trim()) return;
    if (!isAllowed(await loadAllowed(), course.id)) {
      setNote("Allow this course for chat first. Nothing is sent until you do.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const ai = await loadAi();
      if (chatMode(ai) === "find") {
        const found = findPassages(index.index, text, courseLabel);
        setTurns((t) => [...t, { question: text, answer: found.length === 0 ? "Not in the course files." : "", cited: [], invalid: [], found }]);
        setQuestion("");
        return;
      }
      const hits: Hit[] = search(index.index, text, 8);
      if (hits.length === 0) {
        setTurns((t) => [...t, { question: text, answer: "Not in the course files.", cited: [], invalid: [] }]);
        return;
      }
      const answer = await complete(ai, SYSTEM, buildUser(courseLabel, text, hits));
      const { cited, invalid } = citationsIn(answer, courseLabel, hits);
      setTurns((t) => [...t, { question: text, answer, cited, invalid }]);
      setQuestion("");
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reviewGuide = (title: string) => ask(`Write a review guide for ${title}: the topics to know, each with the key facts, citing every line.`);

  return (
    <div className="mx-auto max-w-3xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Course chat</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Ask about a course or ask for a review guide. Answers come only from the course's own text and cite where they found it.
        With your own key (Settings), only the few passages found for each question are sent to Anthropic, model {MODEL}. Pages, assignments,
        announcements and the syllabus are searched; PDFs and slides are not read yet. Without a key it runs as Find (no AI):
        the best matching passages with their citations, dates in bold, and nothing sent anywhere.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <select
          className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600"
          value={course?.id ?? ""}
          onChange={(e) => { setCourseId(Number(e.target.value)); setTurns([]); setIndex(null); }}
        >
          {courses.map((c) => <option key={c.id} value={c.id}>{c.courseCode || c.name}</option>)}
        </select>
        <ShowAllCourses hiddenCount={filter.hidden.length} showAll={filter.showAll} onToggle={filter.toggle} />
        <button type="button" className={button} disabled={busy || !course} onClick={load}>
          {index?.courseId === course?.id ? "Reload course text" : "Load course text"}
        </button>
        {index?.courseId === course?.id && index && (
          <span className="self-center text-xs text-zinc-500">{index.index.chunks.length} passages from {index.docs} pages; {index.files} files not read</span>
        )}
      </div>

      {course && (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={courseAllowed} onChange={(e) => void allow(e.target.checked)} />
          <span>
            Allow chat for {courseLabel}. {CHAT_OPT_IN_TEXT}
          </span>
        </label>
      )}

      {note && <p className="mt-3 text-sm">{note}</p>}

      {index?.courseId === course?.id && index && (
        <>
          <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
            <input
              className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600"
              placeholder="What is skin depth?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button type="submit" className={button} disabled={busy || !question.trim()}>Ask</button>
          </form>
          {exams.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              Review guide for:{" "}
              {exams.map((e) => (
                <button key={e.id} type="button" className="mr-2 underline" disabled={busy} onClick={() => void reviewGuide(e.title)}>{e.title}</button>
              ))}
            </p>
          )}
        </>
      )}

      <div className="mt-6 space-y-6">
        {[...turns].reverse().map((t, i) => (
          <article key={turns.length - i} className="text-sm">
            <p className="font-medium">{t.question}</p>
            {t.found && <p className="mt-0.5 text-xs text-zinc-500">Find (no AI)</p>}
            <p className="mt-1 whitespace-pre-wrap">{t.answer}</p>
            {t.found && t.found.length > 0 && (
              <ol className="mt-2 space-y-3">
                {t.found.map((f) => (
                  <li key={f.n}>
                    <p className="whitespace-pre-wrap">
                      {f.segments.map((seg, k) => (seg.date ? <strong key={k}>{seg.text}</strong> : <span key={k}>{seg.text}</span>))}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">[{f.n}] {f.label}</p>
                  </li>
                ))}
              </ol>
            )}
            {t.cited.length > 0 && (
              <ul className="mt-2 text-xs text-zinc-500">
                {t.cited.map((c) => <li key={c.n}>[{c.n}] {c.label}</li>)}
              </ul>
            )}
            {t.invalid.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                The answer cited {t.invalid.map((n) => `[${n}]`).join(", ")}, which was not among the passages sent. Do not trust those lines.
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
