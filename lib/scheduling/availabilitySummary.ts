/** Compact read-only weekly summary; never infer availability from an absent row. */
export type AvailabilitySummaryRow = Record<string, unknown>;

export type StaffWeeklyAvailabilitySummary = {
  availableWindows: number;
  confirmedWindows: number;
  confirmedNoWorkDays: number;
  unrecordedDays: number;
};

export function summarizeStaffWeeklyAvailability(
  windows: readonly AvailabilitySummaryRow[],
  preferences: readonly AvailabilitySummaryRow[],
  employeeId: string,
  localDate: string,
): StaffWeeklyAvailabilitySummary {
  // This is a current-period *recording* summary, not an optimizer or shift forecast.
  // Date strings are canonical YYYY-MM-DD business-local calendar dates.
  const active = (row: AvailabilitySummaryRow) =>
    typeof row.effective_from === "string" &&
    row.effective_from <= localDate &&
    (row.effective_to == null ||
      (typeof row.effective_to === "string" && row.effective_to >= localDate));
  const hardDays = new Set<number>();
  for (const row of preferences) {
    if (row.employee_id !== employeeId || row.confirmation !== "owner_confirmed" ||
        !active(row) || !Array.isArray(row.unavailable_weekdays)) continue;
    for (const day of row.unavailable_weekdays) {
      if (Number.isInteger(day) && day >= 0 && day <= 6) hardDays.add(day);
    }
  }

  const recordedDays = new Set<number>();
  let availableWindows = 0;
  let confirmedWindows = 0;
  for (const row of windows) {
    if (row.employee_id !== employeeId || !active(row) ||
        !Number.isInteger(row.day_of_week)) continue;
    const day = row.day_of_week as number;
    if (day < 0 || day > 6 || hardDays.has(day)) continue;
    recordedDays.add(day);
    availableWindows += 1;
    if (row.confirmation === "owner_confirmed") confirmedWindows += 1;
  }
  return {
    availableWindows,
    confirmedWindows,
    confirmedNoWorkDays: hardDays.size,
    unrecordedDays: 7 - hardDays.size - recordedDays.size,
  };
}
