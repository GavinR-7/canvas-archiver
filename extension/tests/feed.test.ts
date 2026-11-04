import { describe, expect, it } from "vitest";
import { minutesUntilHour } from "@/src/feed/settings";

describe("minutesUntilHour", () => {
  it("is later today when the hour is ahead", () => {
    expect(minutesUntilHour(new Date(2026, 9, 15, 22, 0), 23)).toBe(60);
  });
  it("rolls to tomorrow when the hour has passed", () => {
    expect(minutesUntilHour(new Date(2026, 9, 15, 22, 0), 2)).toBe(4 * 60);
  });
  it("never schedules in the past or right now", () => {
    expect(minutesUntilHour(new Date(2026, 9, 15, 2, 0), 2)).toBe(24 * 60);
  });
});
