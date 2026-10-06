import { describe, expect, it } from "vitest";
import {
  normalizeOpenHours,
  openHoursToWeeklyInput,
  regularHoursStateForDate,
  weeklyInputToOpenHours,
} from "./openHours";

describe("open hours", () => {
  it("keeps explicit closed days separate from unset days", () => {
    const hours = normalizeOpenHours({
      mon: [["08:00", "17:00"]],
      sat: [],
    });
    expect(regularHoursStateForDate(hours, "2026-10-05")).toBe("open"); // Monday
    expect(regularHoursStateForDate(hours, "2026-10-03")).toBe("closed"); // Saturday
    expect(regularHoursStateForDate(hours, "2026-10-04")).toBe("unknown"); // Sunday unset
  });

  it("rejects malformed intervals without turning them into a closed day", () => {
    const hours = normalizeOpenHours({ sat: [["bad", "17:00"]] });
    expect(hours).toBeNull();
  });

  it("round-trips open, closed, and unset day modes", () => {
    const input = openHoursToWeeklyInput({
      mon: [["07:00", "15:30"]],
      tue: [],
    });
    expect(input.mon).toEqual({ mode: "open", open: "07:00", close: "15:30" });
    expect(input.tue).toEqual({ mode: "closed" });
    expect(input.wed).toEqual({ mode: "unset" });

    const stored = weeklyInputToOpenHours(input);
    expect(stored?.mon).toEqual([["07:00", "15:30"]]);
    expect(stored?.tue).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(stored ?? {}, "wed")).toBe(false);
  });
});
