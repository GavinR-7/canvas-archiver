/**
 * The weekly schedule: classes you entered, with your deadlines on the days
 * they fall. Class times are never guessed: the list starts empty and fills
 * from what you paste (the table from gavin-data's schedule.md works as-is).
 * With deadline sync on (Settings), the classes are also written to
 * schedule.json next to due.json for HQ to read.
 */

import { useEffect, useMemo, useState } from "react";
import { easternDay } from "@/src/dates/merge";
import {
  addDays, agendaBlocks, DAYS, formatScheduleTime, layoutTimedTiles, layoutWeek, loadClasses, minutes, mondayOf,
  parseScheduleTable, saveClasses, weekDisplayRange, type Block, type ClassMeeting, type DayColumn, type TimedTile,
} from "@/src/schedule/model";
import { useSnapshot } from "@/src/ui/useSnapshot";

const PX = 0.8; // pixels per minute
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
});
const blockTime = (block: Block) => block.kind === "deadline"
  ? formatScheduleTime(block.to)
  : `${formatScheduleTime(block.from)}–${formatScheduleTime(block.to)}`;

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
        snapshot.tasks.flatMap((task) => task.dueAt ? [{
          id: task.id, title: task.title, course: task.courseCode || task.courseName,
          dueAt: task.dueAt, allDay: task.allDay, href: task.htmlUrl, unconfirmed: task.unconfirmed,
        }] : []),
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

  const { start, end } = weekDisplayRange(columns);
  const height = (end - start) * PX;
  const hours = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);
  const timeline = columns.map((day) => {
    const tiles = layoutTimedTiles(day.blocks, start, end, PX);
    const lanes = tiles.reduce((max, tile) => Math.max(max, tile.lanes), 1);
    return { day, tiles, width: Math.max(92, lanes * 58) };
  });
  const gridColumns = ["62px", ...timeline.map(({ width }) => `minmax(${width}px, 1fr)`)].join(" ");
  return (
    <div className="mx-auto max-w-6xl p-6 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-xl font-semibold">Week schedule</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Times in Eastern.</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
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

      <Agenda columns={columns} />
      <div className="mt-4 hidden overflow-x-auto pb-2 lg:block">
        <div className="grid min-w-[760px]" style={{ gridTemplateColumns: gridColumns }}>
          <div />
          {columns.map((c, i) => (
            <div key={c.date} className="border-b border-zinc-200 px-1 pb-1 text-center text-xs font-medium dark:border-zinc-700">
              {dayName(c.date)}
              {c.allDay.map((block) => (
                <div key={block.id} className={`mt-1 truncate rounded px-1 text-left text-[11px] ${block.unconfirmed ? "bg-amber-500/20" : "bg-rose-500/20"}`} title={`All day · ${block.label}`}>
                  <BlockName block={block} />
                </div>
              ))}
              <span className="sr-only">{DAYS[i]}</span>
            </div>
          ))}
          <div className="relative" style={{ height }}>
            {hours.map((h) => (
              <span key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-zinc-500" style={{ top: (h - start) * PX }}>{formatScheduleTime(h)}</span>
            ))}
          </div>
          {timeline.map(({ day, tiles }) => (
            <div key={day.date} className="relative border-l border-zinc-200 dark:border-zinc-700" style={{ height }}>
              {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800" style={{ top: (h - start) * PX }} />)}
              {tiles.map((tile) => <BlockView key={tile.block.id} tile={tile} />)}
            </div>
          ))}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="font-medium">Classes</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {classes.map((c) => (
            <li key={c.id}>
              {c.course} {c.title} · {c.days.join(" ")} {formatScheduleTime(minutes(c.start))}–{formatScheduleTime(minutes(c.end))} · {c.location}{" "}
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

function BlockName({ block }: { block: Block }) {
  return block.href ? (
    <a href={block.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {block.label}
    </a>
  ) : <span>{block.label}</span>;
}

function Agenda({ columns }: { columns: DayColumn[] }) {
  const days = columns.filter((column) => column.allDay.length || column.blocks.length);
  return (
    <section aria-label="Week agenda" className="mt-4 space-y-4 lg:hidden">
      {days.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No classes or deadlines this week.</p>}
      {days.map((day) => (
        <div key={day.date}>
          <h2 className="mb-1 text-sm font-semibold">{dayName(day.date)}</h2>
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 px-3 dark:divide-zinc-800 dark:border-zinc-800">
            {agendaBlocks(day).map((block, index) => (
              <li key={block.id} className="py-2 text-sm">
                <div className="break-words font-medium"><BlockName block={block} /></div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {index < day.allDay.length ? "All day" : blockTime(block)}
                  {block.kind === "deadline" ? " · Deadline" : block.detail ? ` · ${block.detail}` : ""}
                  {block.unconfirmed && " · Unconfirmed"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function BlockView({ tile }: { tile: TimedTile }) {
  const { block, top, height, lane, lanes } = tile;
  const style = block.kind === "class" ? "bg-sky-500/25 border-sky-500/50" : block.unconfirmed ? "bg-amber-500/25 border-amber-500/60" : "bg-rose-500/25 border-rose-500/60";
  const time = blockTime(block);
  const content = (
    <div className="truncate font-medium">
      {block.kind === "deadline" && <span className="mr-1">{time}</span>}
      <span>{block.label}</span>
    </div>
  );
  return (
    <div
      className={`absolute overflow-hidden rounded border text-[10px] leading-tight ${style}`}
      style={{ top, height, left: `calc(${lane * 100 / lanes}% + 1px)`, width: `calc(${100 / lanes}% - 2px)` }}
      title={`${time} · ${block.label} ${block.detail}`}
    >
      {block.href ? (
        <a
          href={block.href} target="_blank" rel="noreferrer" aria-label={block.label}
          className="block h-full px-1 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset"
        >
          {content}
        </a>
      ) : <div className="px-1">{content}</div>}
      {block.kind === "class" && height > 26 && (
        <div className="truncate px-1 text-zinc-600 dark:text-zinc-300">{time} {block.detail}</div>
      )}
    </div>
  );
}
