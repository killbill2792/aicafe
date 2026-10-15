import { describe, expect, it } from "vitest";
import { summarizeStaffWeeklyAvailability as summarize } from "./availabilitySummary";

const now = "2026-10-14";
const a = "employee-a";
const window = (day: number, extras: Record<string, unknown> = {}) => ({
  employee_id: a, effective_from: "2026-10-01", effective_to: null,
  day_of_week: day, confirmation: "owner_confirmed", ...extras,
});
const hard = (days: number[], extras: Record<string, unknown> = {}) => ({
  employee_id: a, effective_from: "2026-10-01", effective_to: null,
  confirmation: "owner_confirmed", unavailable_weekdays: days, ...extras,
});

describe("Olivia collapsed weekly availability summary", () => {
  it("keeps entirely unrecorded availability unknown", () => {
    expect(summarize([], [], a, now)).toEqual({
      availableWindows: 0, confirmedWindows: 0, confirmedNoWorkDays: 0, unrecordedDays: 7,
    });
  });
  it("recognizes seven confirmed no-work days without a positive window", () => {
    expect(summarize([], [hard([0,1,2,3,4,5,6])], a, now)).toEqual({
      availableWindows: 0, confirmedWindows: 0, confirmedNoWorkDays: 7, unrecordedDays: 0,
    });
  });
  it("does not misreport stale overlapping windows as working hours on hard days", () => {
    expect(summarize([window(1),window(5)], [hard([0,1,2,3,4,5,6])], a, now))
      .toMatchObject({ availableWindows: 0, confirmedNoWorkDays: 7, unrecordedDays: 0 });
  });
  it("separates confirmed no-work, recorded windows and missing days", () => {
    expect(summarize([window(1),window(2),window(4,{confirmation:"unconfirmed"})],
      [hard([2])], a, now)).toEqual({
      availableWindows: 2, confirmedWindows: 1, confirmedNoWorkDays: 1, unrecordedDays: 4,
    });
  });
  it("ignores unconfirmed restrictions and those outside the active period", () => {
    const future = hard([1,2,3], {effective_from:"2026-11-01"});
    expect(summarize([window(1)], [hard([1],{confirmation:"unconfirmed"}), future],
      a, now)).toMatchObject({availableWindows:1,confirmedNoWorkDays:0,unrecordedDays:6});
  });
  it("does not borrow availability or restrictions from another worker", () => {
    const b = {employee_id:"employee-b"};
    expect(summarize([window(1,b)], [hard([1,2,3,4,5,6,0],b)], a, now))
      .toMatchObject({availableWindows:0,confirmedNoWorkDays:0,unrecordedDays:7});
  });
  it("respects closed effective ranges and deduplicates no-work weekdays", () => {
    const pastWindow=window(1,{effective_to:"2026-10-13"});
    expect(summarize([pastWindow], [hard([1,1,2])], a, now))
      .toMatchObject({availableWindows:0,confirmedNoWorkDays:2,unrecordedDays:5});
  });
});
