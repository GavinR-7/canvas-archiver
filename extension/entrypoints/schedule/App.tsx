/**
 * The weekly schedule: classes you entered, with your deadlines on the days
 * they fall. Class times are never guessed: the list starts empty and fills
 * from what you paste (the table from gavin-data's schedule.md works as-is).
 * With deadline sync on (Settings), the classes are also written to
 * schedule.json next to due.json for HQ to read.
 */

import { useEffect, useMemo, useState } from "react";
import { easternDay } from "@/src/dates/merge";
import { addDays, DAYS, layoutWeek, loadClasses, mondayOf, parseScheduleTable, saveClasses, type Block, type ClassMeeting } from "@/src/schedule/model";
import { useSnapshot } from "@/src/ui/useSnapshot";

const START = 7 * 60;
const END = 23 * 60;
const PX = 0.8; // pixels per minute
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const clock = (min: number) => {
  const h = Math.floor(min / 60);
  return `${((h + 11) % 12) + 1}:${String(min % 60).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
};

export default function App() {
  const { snapshot } = useSnapshot();
  const [classes, setClasses] = useState<ClassMeeting[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [week, setWeek] = useState(() => mondayOf(easternDay(new Date().toISOString())));
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { void loadClasses().then((c) => { setClasses(c); setLoaded(true); }); }, []);

  const columns = useMemo(
    () =>
      layoutWeek(
        week,
        classes,
        snapshot.tasks.filter((t) => t.dueAt).map((t) => ({ id: t.id, title: t.title, course: t.courseCode || t.courseName, dueAt: t.dueAt as string, allDay: t.allDay, unconfirmed: t.unconfirmed })),
      ),
    [week, classes, snapshot.tasks],
  );

  const importText = async () => {
    const result = parseScheduleTable(paste);
    if (result.classes.length === 0) return setNote("No class rows found. Paste a table with Course | Days | Time | Location columns.");
    const merged = new Map(classes.map((c) => [c.id, c]));
    for (const c of result.classes) merged.set(c.id, c);
    const next = [...merged.values()];
    await saveClasses(next);
    setClasses(next);
    setPaste("");
    setNote(`Added ${result.classes.length} meetings.${result.skipped.length ? ` ${result.skipped.length} rows could not be read: ${result.skipped.join(" ; ")}` : ""}`);
  };

  const remove = async (id: string) => {
    const next = classes.filter((c) => c.id !== id);
    await saveClasses(next);
    setClasses(next);
  };

  const hours = Array.from({ length: (END - START) / 60 + 1 }, (_, i) => START + i * 60);
  return (
    <div className="mx-auto max-w-6xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Week schedule</h1>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <button type="button" className="underline" onClick={() => setWeek(addDays(week, -7))}>← Previous</button>
        <strong>Week of {dayName(week)}</strong>
        <button type="button" className="underline" onClick={() => setWeek(addDays(week, 7))}>Next →</button>
        <button type="button" className="underline" onClick={() => setWeek(mondayOf(easternDay(new Date().toISOString())))}>This week</button>
      </div>

      {loaded && classes.length === 0 && (
        <p className="mt-4 rounded-lg border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
          No classes entered yet, so only deadlines show. Add your classes below; nothing is guessed.
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <div className="grid min-w-[760px]" style={{ gridTemplateColumns: "44px repeat(7, minmax(0, 1fr))" }}>
          <div />
          {columns.map((c, i) => (
            <div key={c.date} className="border-b border-zinc-200 px-1 pb-1 text-center text-xs font-medium dark:border-zinc-700">
              {dayName(c.date).replace(/^\w+,?\s*/, (m) => `${m}`)}
              {c.allDay.map((d) => (
                <div key={d.id} className={`mt-1 truncate rounded px-1 text-left text-[11px] ${d.unconfirmed ? "bg-amber-500/20" : "bg-rose-500/20"}`} title={d.label}>{d.label}</div>
              ))}
              <span className="sr-only">{DAYS[i]}</span>
            </div>
          ))}
          <div className="relative" style={{ height: (END - START) * PX }}>
            {hours.map((h) => (
              <span key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-zinc-400" style={{ top: (h - START) * PX }}>{clock(h)}</span>
            ))}
          </div>
          {columns.map((c) => (
            <div key={c.date} className="relative border-l border-zinc-200 dark:border-zinc-700" style={{ height: (END - START) * PX }}>
              {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800" style={{ top: (h - START) * PX }} />)}
              {c.blocks.map((b) => <BlockView key={b.id} block={b} />)}
            </div>
          ))}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="font-medium">Classes</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {classes.map((c) => (
            <li key={c.id}>
              {c.course} {c.title} · {c.days.join(" ")} {clock(Number(c.start.slice(0, 2)) * 60 + Number(c.start.slice(3)))}–{clock(Number(c.end.slice(0, 2)) * 60 + Number(c.end.slice(3)))} · {c.location}{" "}
              <button type="button" className="text-xs underline" onClick={() => void remove(c.id)}>remove</button>
            </li>
          ))}
        </ul>
        <label className="mt-4 block text-sm">
          Paste a schedule table (Course | Days | Time | Location)
          <textarea className="mt-1 h-28 w-full rounded border border-zinc-300 bg-transparent p-2 font-mono text-xs dark:border-zinc-600" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="| ECE 3030 Lecture | Mon Wed Fri | 10:10-11:00 am | Hollister Hall B14 |" />
        </label>
        <button type="button" className="mt-2 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900" disabled={!paste.trim()} onClick={() => void importText()}>Add these classes</button>
        {note && <p className="mt-2 text-sm">{note}</p>}
      </section>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  const top = (Math.max(block.from, START) - START) * PX;
  const height = Math.max(14, (Math.min(block.to, END) - Math.max(block.from, START)) * PX);
  const style = block.kind === "class" ? "bg-sky-500/25 border-sky-500/50" : block.unconfirmed ? "bg-amber-500/25 border-amber-500/60" : "bg-rose-500/25 border-rose-500/60";
  return (
    <div className={`absolute inset-x-0.5 overflow-hidden rounded border px-1 text-[10px] leading-tight ${style}`} style={{ top, height }} title={`${block.label} ${block.detail}`}>
      <div className="truncate font-medium">{block.label}</div>
      {height > 26 && <div className="truncate text-zinc-600 dark:text-zinc-300">{clock(block.from)}–{clock(block.to)} {block.detail}</div>}
    </div>
  );
}
