export type StaffScheduleMaterializationRow = {
  id: string;
  employee_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  unpaid_break_minutes: number;
  hourly_wage_cents: number;
  effective_from: string;
  effective_to: string | null;
};

function localDayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function localDatesInclusive(startDate: string, endDate: string): string[] {
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];

  const dates: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) {
    const date = new Date(timestamp);
    dates.push(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return dates;
}

/**
 * Returns at most one applicable schedule per employee for one local business date.
 * A month-bounded row overrides an ongoing row for the same employee/date.
 */
export function selectSchedulesForDate(
  schedules: StaffScheduleMaterializationRow[],
  date: string,
): StaffScheduleMaterializationRow[] {
  const dayOfWeek = localDayOfWeek(date);
  const byEmployee = new Map<string, StaffScheduleMaterializationRow[]>();

  for (const schedule of schedules) {
    if (schedule.day_of_week !== dayOfWeek) continue;
    if (schedule.effective_from > date) continue;
    if (schedule.effective_to && schedule.effective_to < date) continue;
    const rows = byEmployee.get(schedule.employee_id) ?? [];
    rows.push(schedule);
    byEmployee.set(schedule.employee_id, rows);
  }

  return [...byEmployee.values()].map((rows) =>
    [...rows].sort((left, right) => {
      const leftBounded = left.effective_to !== null ? 1 : 0;
      const rightBounded = right.effective_to !== null ? 1 : 0;
      if (leftBounded !== rightBounded) return rightBounded - leftBounded;
      const effective = right.effective_from.localeCompare(left.effective_from);
      if (effective !== 0) return effective;
      return left.id.localeCompare(right.id);
    })[0],
  );
}
