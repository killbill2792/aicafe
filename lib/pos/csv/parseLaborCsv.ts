import { toCents, toDateStr, toIsoTimestamp } from "./csvUtils";

export type LaborColumnMapping = {
  employee: string;
  date: string;
  clockIn: string;
  clockOut: string;
  hourlyWage: string;
};

export type NormalizedLaborRow = {
  employee: string;
  clockIn: string; // ISO timestamp, business-local (no tz conversion — see caller)
  clockOut: string | null;
  hourlyWageCents: number;
};

/** Toast's "Labor time entries" export (and equivalents). */
export function parseLaborCsv(rows: Record<string, string>[], mapping: LaborColumnMapping): NormalizedLaborRow[] {
  return rows
    .map((row) => {
      const date = toDateStr(row[mapping.date] ?? "");
      const clockOutRaw = (row[mapping.clockOut] ?? "").trim();
      return {
        employee: (row[mapping.employee] ?? "").trim(),
        clockIn: toIsoTimestamp(date, row[mapping.clockIn] ?? ""),
        clockOut: clockOutRaw ? toIsoTimestamp(date, clockOutRaw) : null,
        hourlyWageCents: toCents(row[mapping.hourlyWage] ?? "0"),
      };
    })
    .filter((r) => r.employee && r.clockIn);
}
