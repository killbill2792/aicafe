import { describe, expect, it } from "vitest";
import type { StaffScheduleRow } from "@/lib/data/getStaffSchedules";
import { clearNewEmployeeGuidance, schedulesForMonth, summarizeStaffSchedule } from "./staffManagement";

function row(id: string, dayOfWeek: number, startTime: string, endTime: string, effectiveFrom: string, effectiveTo: string | null, unpaidBreakMinutes = 30): StaffScheduleRow {
  return { id, employeeId: "employee", dayOfWeek, startTime, endTime, unpaidBreakMinutes, hourlyWageCents: 2000, effectiveFrom, effectiveTo };
}

describe("Manage Staff schedule summaries", () => {
  it("consumes one-time schedule guidance only after that new employee saves", () => {
    expect(clearNewEmployeeGuidance("new-employee", "new-employee")).toBeNull();
    expect(clearNewEmployeeGuidance("new-employee", "existing-employee")).toBe("new-employee");
  });

  it("uses a current-month schedule instead of incorrectly reporting the ongoing schedule", () => {
    const ongoing = row("ongoing", 1, "08:00", "16:00", "2026-01-01", null);
    const october = row("october", 2, "09:00", "15:00", "2026-10-01", "2026-10-31");
    expect(schedulesForMonth([ongoing, october], "2026-10")).toEqual([october]);
  });

  it("does not pretend different days share one time range", () => {
    const summary = summarizeStaffSchedule([
      row("mon", 1, "08:00", "16:00", "2026-01-01", null),
      row("tue", 2, "10:00", "18:00", "2026-01-01", null),
    ]);
    expect(summary).toMatchObject({ dayNumbers: [1, 2], timeRange: null, timesVary: true, breakMinutes: 30, breaksVary: false });
  });
});
