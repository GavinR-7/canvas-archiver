import { describe, expect, it } from "vitest";
import {
  addDays, agendaBlocks, buildScheduleFile, formatScheduleTime, layoutTimedTiles, layoutWeek, mondayOf, parseDays,
  parseScheduleTable, parseTimeRange, sameSchedule, serializeSchedule, weekDisplayRange, type Block,
} from "@/src/schedule/model";
import { schedulePath } from "@/src/sync/run";

const TABLE = `| Course | Days | Time | Location |
|---|---|---|---|
| ECE 3030 Lecture (EM Fields & Waves) | Mon Wed Fri | 10:10-11:00 am | Hollister Hall B14 |
| HIST 2369 Seminar | Tue Thu | 11:40 am-12:55 pm | Upson Hall 202 |
| ECE 3140 Discussion | Mon | 1:25-2:15 pm | Phillips Hall 219 |
| CS 3700 Lecture (AI Reasoning) | Mon Wed | 2:55-4:10 pm | Olin Hall 155 |
| PE 1300 Bowling | Thu | 5:15-6:45 pm | Helen Newman Hall B22 |
| Broken row | whenever | soon | nowhere |`;

describe("parsing", () => {
  it("reads days", () => {
    expect(parseDays("Mon Wed Fri")).toEqual(["mon", "wed", "fri"]);
    expect(parseDays("TR")).toEqual(["tue", "thu"]);
    expect(parseDays("Tuesday, Thursday")).toEqual(["tue", "thu"]);
  });
  it("reads time ranges, borrowing am/pm sensibly", () => {
    expect(parseTimeRange("10:10-11:00 am")).toEqual({ start: "10:10", end: "11:00" });
    expect(parseTimeRange("11:40 am-12:55 pm")).toEqual({ start: "11:40", end: "12:55" });
    expect(parseTimeRange("1:25-2:15 pm")).toEqual({ start: "13:25", end: "14:15" });
    expect(parseTimeRange("11:30-1:00 pm")).toEqual({ start: "11:30", end: "13:00" });
    expect(parseTimeRange("soon")).toBeNull();
  });
  it("imports the real schedule.md table and reports rows it cannot read", () => {
    const r = parseScheduleTable(TABLE);
    expect(r.classes).toHaveLength(5);
    expect(r.skipped).toHaveLength(1);
    expect(r.classes[0]).toMatchObject({ course: "ECE 3030", title: "Lecture (EM Fields & Waves)", days: ["mon", "wed", "fri"], start: "10:10", end: "11:00", location: "Hollister Hall B14" });
    expect(r.classes[4]).toMatchObject({ course: "PE 1300", start: "17:15", end: "18:45" });
  });
  it("gives re-imports the same ids", () => {
    expect(parseScheduleTable(TABLE).classes.map((c) => c.id)).toEqual(parseScheduleTable(TABLE).classes.map((c) => c.id));
  });
});

describe("export", () => {
  const classes = parseScheduleTable(TABLE).classes;
  it("is stable and ignores generatedAt when comparing", () => {
    const a = buildScheduleFile(classes, new Date("2026-10-15T10:00:00Z"));
    const b = buildScheduleFile([...classes].reverse(), new Date("2026-10-16T10:00:00Z"));
    expect(sameSchedule(serializeSchedule(a), b)).toBe(true);
    expect(sameSchedule(serializeSchedule(a), buildScheduleFile(classes.slice(1), new Date()))).toBe(false);
    expect(a.timezone).toBe("America/New_York");
  });
  it("sits next to due.json", () => {
    expect(schedulePath("due.json")).toBe("schedule.json");
    expect(schedulePath("hq/due.json")).toBe("hq/schedule.json");
  });
});

describe("week layout", () => {
  const classes = parseScheduleTable(TABLE).classes;
  it("finds Monday and adds days", () => {
    expect(mondayOf("2026-10-15")).toBe("2026-10-12"); // Thursday
    expect(mondayOf("2026-10-18")).toBe("2026-10-12"); // Sunday
    expect(addDays("2026-10-26", 7)).toBe("2026-11-02");
  });
  it("keeps normal daytime hours for a standard week", () => {
    const week = layoutWeek("2026-10-12", classes, [
      { id: "day", title: "All day", course: "X", dueAt: "2026-10-16T03:59:00Z", allDay: true },
    ]);
    expect(weekDisplayRange(week)).toEqual({ start: 7 * 60, end: 23 * 60 });
  });

  it("encloses extra-early classes and retains the true midnight and 11:59 PM deadlines", () => {
    const week = layoutWeek("2026-10-12", [
      { id: "early", course: "X", title: "Lab", days: ["mon"], start: "06:25", end: "07:10", location: "Room 1" },
    ], [
      { id: "midnight", title: "Midnight", course: "X", dueAt: "2026-10-12T04:00:00Z", allDay: false },
      {
        id: "late", title: "Late", course: "X", dueAt: "2026-10-19T03:59:00Z", allDay: false,
        href: "https://canvas.example.test/courses/11/assignments/42",
      },
    ]);
    expect(weekDisplayRange(week)).toEqual({ start: 0, end: 24 * 60 });
    expect(week[0]!.blocks).toEqual([
      expect.objectContaining({ id: "midnight", from: 0, to: 0 }),
      expect.objectContaining({ id: "early@2026-10-12", from: 385, to: 430 }),
    ]);
    expect(week[6]!.blocks).toEqual([
      expect.objectContaining({ id: "late", from: 1419, to: 1439, href: "https://canvas.example.test/courses/11/assignments/42" }),
    ]);
    expect(formatScheduleTime(0)).toBe("12:00 AM");
    expect(formatScheduleTime(1439)).toBe("11:59 PM");
    expect(formatScheduleTime(1440)).toBe("12:00 AM");
  });

  it("gives simultaneous 11:59 PM deadlines separate tiles", () => {
    const [day] = layoutWeek("2026-10-12", [], ["a", "b"].map((id) => ({
      id, title: id, course: "X", dueAt: "2026-10-13T03:59:00Z", allDay: false,
      href: `https://canvas.example.test/tasks/${id}`,
    })));
    const tiles = layoutTimedTiles(day!.blocks, 23 * 60, 24 * 60, 0.8);
    expect(tiles.map(({ lane, lanes, block }) => [lane, lanes, block.id])).toEqual([[0, 2, "a"], [1, 2, "b"]]);
    expect(tiles.every(({ top, height }) => top >= 0 && top + height <= 48)).toBe(true);
  });

  it("sizes transitive overlaps together and allows adjacent tiles to use full width", () => {
    const block = (id: string, from: number, to: number): Block => ({ id, from, to, label: id, kind: "class", detail: "" });
    const tiles = layoutTimedTiles([
      block("a", 0, 14),
      block("b", 14, 16), block("c", 20, 22), block("d", 30, 35),
      block("e", 59, 60), block("f", 56, 58),
    ], 0, 60, 1);
    expect(tiles.map(({ block, top, height, lane, lanes }) => [block.id, top, height, lane, lanes])).toEqual([
      ["a", 0, 14, 0, 1],
      ["b", 14, 14, 0, 2], ["c", 20, 14, 1, 2], ["d", 30, 14, 0, 2],
      ["e", 46, 14, 0, 2], ["f", 46, 14, 1, 2],
    ]);
  });

  it("orders the agenda by displayed time while preserving the timeline's marker placement", () => {
    const [monday] = layoutWeek("2026-10-12", [
      { id: "meeting", course: "X", title: "Lab", days: ["mon"], start: "09:00", end: "09:50", location: "" },
    ], [
      { id: "later", title: "At 9:15", course: "X", dueAt: "2026-10-12T13:15:00Z", allDay: false },
      { id: "same-time", title: "At 9:00", course: "X", dueAt: "2026-10-12T13:00:00Z", allDay: false },
      { id: "any-time", title: "Any time", course: "X", dueAt: "2026-10-12T18:00:00Z", allDay: true },
    ]);
    expect(agendaBlocks(monday!).map((block) => block.id)).toEqual([
      "any-time", "meeting@2026-10-12", "same-time", "later",
    ]);
    expect(monday!.blocks.map((block) => block.id)).toEqual(["same-time", "later", "meeting@2026-10-12"]);
  });

  it("places classes on their days and deadlines at Eastern time", () => {
    const week = layoutWeek("2026-10-12", classes, [
      { id: "d1", title: "HW 5", course: "ECE 3030", dueAt: "2026-10-16T01:00:00Z", allDay: false }, // Thu 9:00 pm EDT
      { id: "d2", title: "Prelim", course: "CS 3700", dueAt: "2026-10-16T03:59:00Z", allDay: true, unconfirmed: true }, // Thu 11:59 pm EDT
      { id: "d3", title: "Later", course: "X", dueAt: "2026-11-30T12:00:00Z", allDay: false },
    ]);
    const mon = week[0]!;
    expect(mon.blocks.filter((b) => b.kind === "class").map((b) => b.label)).toEqual(["ECE 3030 Lecture (EM Fields & Waves)", "ECE 3140 Discussion", "CS 3700 Lecture (AI Reasoning)"]);
    const thu = week[3]!;
    expect(thu.blocks.find((b) => b.id === "d1")).toMatchObject({ from: 21 * 60 - 20, to: 21 * 60, kind: "deadline" });
    expect(thu.allDay.map((b) => b.id)).toEqual(["d2"]);
    expect(week.flatMap((d) => d.blocks).some((b) => b.id === "d3")).toBe(false);
  });
});
