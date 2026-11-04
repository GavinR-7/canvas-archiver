import { describe, expect, it } from "vitest";
import { addDays, buildScheduleFile, layoutWeek, mondayOf, parseDays, parseScheduleTable, parseTimeRange, sameSchedule, serializeSchedule } from "@/src/schedule/model";
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
