import { describe, expect, it } from "vitest";
import type { StaffShift } from "@/lib/data/types";
import { resolvedTimecardSource, staffAttendanceIssue } from "./staffAttendance";

function shift(overrides: Partial<StaffShift> = {}): StaffShift {
  return {
    employeeId: "employee-1",
    name: "Ana",
    role: "Barista",
    timecard: {
      clockIn: "2026-10-06T15:00:00Z",
      clockOut: "2026-10-06T23:00:00Z",
      hourlyWageCents: 2200,
      breaks: [],
      sourceType: "pos",
      sourceProvider: "square",
    },
    expectedSchedule: {
      scheduleId: "schedule-1",
      clockIn: "2026-10-06T15:00:00Z",
      clockOut: "2026-10-06T23:00:00Z",
    },
    ...overrides,
  };
}

describe("staff attendance provenance", () => {
  it("keeps legacy schedule rows conservative", () => {
    expect(resolvedTimecardSource({ clockIn: "2026-10-06T15:00:00Z", clockOut: null, hourlyWageCents: 2000, breaks: [], scheduleId: "s1" }))
      .toBe("owner_manual_schedule");
  });

  it("does not flag a schedule-only expectation", () => {
    expect(staffAttendanceIssue(shift({
      timecard: {
        clockIn: "2026-10-06T15:00:00Z",
        clockOut: "2026-10-06T23:00:00Z",
        hourlyWageCents: 2200,
        breaks: [],
        scheduleId: "schedule-1",
        sourceType: "owner_manual_schedule",
      },
    }))).toBeNull();
  });

  it("flags actual attendance with no schedule baseline", () => {
    expect(staffAttendanceIssue(shift({ expectedSchedule: null }))).toEqual({ kind: "unscheduled_actual" });
  });

  it("ignores small clock differences and flags meaningful ones", () => {
    expect(staffAttendanceIssue(shift({
      timecard: { ...shift().timecard, clockIn: "2026-10-06T15:06:00Z", clockOut: "2026-10-06T22:55:00Z" },
    }))).toBeNull();

    expect(staffAttendanceIssue(shift({
      timecard: { ...shift().timecard, clockIn: "2026-10-06T15:12:00Z", clockOut: "2026-10-06T22:40:00Z" },
    }))).toEqual({ kind: "schedule_difference", startDifferenceMinutes: 12, endDifferenceMinutes: 20 });
  });
});
