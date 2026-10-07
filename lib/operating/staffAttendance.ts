import type { Timecard, TimecardSourceType } from "@/lib/calc/types";
import type { StaffShift } from "@/lib/data/types";

export type StaffAttendanceIssue =
  | { kind: "unscheduled_actual" }
  | { kind: "schedule_difference"; startDifferenceMinutes: number; endDifferenceMinutes: number | null };

export function resolvedTimecardSource(timecard: Timecard): TimecardSourceType {
  if (timecard.sourceType) return timecard.sourceType;
  if (timecard.scheduleId) return "owner_manual_schedule";
  return "owner_manual";
}

export function isActualAttendance(timecard: Timecard): boolean {
  return resolvedTimecardSource(timecard) !== "owner_manual_schedule";
}

function absoluteMinutesBetween(leftIso: string, rightIso: string): number {
  return Math.round(Math.abs(new Date(leftIso).getTime() - new Date(rightIso).getTime()) / 60_000);
}

/**
 * Returns an owner-review issue only for actual attendance. Schedule-only expectations are never
 * treated as discrepancies. A seven-minute tolerance matches the existing early-clock alert rule.
 */
export function staffAttendanceIssue(shift: StaffShift, toleranceMinutes = 7): StaffAttendanceIssue | null {
  if (!isActualAttendance(shift.timecard)) return null;
  if (!shift.expectedSchedule) return { kind: "unscheduled_actual" };

  const startDifferenceMinutes = absoluteMinutesBetween(shift.timecard.clockIn, shift.expectedSchedule.clockIn);
  const endDifferenceMinutes =
    shift.timecard.clockOut === null
      ? null
      : absoluteMinutesBetween(shift.timecard.clockOut, shift.expectedSchedule.clockOut);

  if (
    startDifferenceMinutes <= toleranceMinutes &&
    (endDifferenceMinutes === null || endDifferenceMinutes <= toleranceMinutes)
  ) {
    return null;
  }

  return { kind: "schedule_difference", startDifferenceMinutes, endDifferenceMinutes };
}
