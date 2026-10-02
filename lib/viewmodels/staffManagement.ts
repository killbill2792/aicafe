import type { StaffScheduleRow } from "@/lib/data/getStaffSchedules";

export type StaffScheduleSummary = {
  dayNumbers: number[];
  timeRange: string | null;
  timesVary: boolean;
  breakMinutes: number | null;
  breaksVary: boolean;
};

export function schedulesForMonth(schedules: StaffScheduleRow[], month: string): StaffScheduleRow[] {
  const bounded = schedules.filter((schedule) => schedule.effectiveTo !== null && schedule.effectiveFrom.slice(0, 7) <= month && schedule.effectiveTo.slice(0, 7) >= month);
  return bounded.length > 0 ? bounded : schedules.filter((schedule) => schedule.effectiveTo === null);
}

export function summarizeStaffSchedule(schedules: StaffScheduleRow[]): StaffScheduleSummary | null {
  if (schedules.length === 0) return null;
  const dayNumbers = [1, 2, 3, 4, 5, 6, 0].filter((day) => schedules.some((schedule) => schedule.dayOfWeek === day));
  const timeRanges = new Set(schedules.map((schedule) => `${schedule.startTime}–${schedule.endTime}`));
  const breaks = new Set(schedules.map((schedule) => schedule.unpaidBreakMinutes));
  return {
    dayNumbers,
    timeRange: timeRanges.size === 1 ? [...timeRanges][0] : null,
    timesVary: timeRanges.size > 1,
    breakMinutes: breaks.size === 1 ? [...breaks][0] : null,
    breaksVary: breaks.size > 1,
  };
}
