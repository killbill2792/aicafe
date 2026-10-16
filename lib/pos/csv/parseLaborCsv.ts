import { toCents, toDateStr, toIsoTimestamp } from "./csvUtils";

export type LaborColumnMapping = {
  employee: string;
  date: string;
  clockIn: string;
  clockOut: string;
  hourlyWage?: string;
};

export type NormalizedLaborRow = {
  employee: string;
  clockIn: string; // ISO timestamp, business-local (no tz conversion — see caller)
  clockOut: string | null;
  /** null = no wage evidence in this file; never a fabricated $0. */
  hourlyWageCents: number | null;
};

export type LaborRejectReason = "missing_employee" | "missing_clock_in" | "invalid_date";

export type ParseLaborCsvResult = {
  valid: NormalizedLaborRow[];
  rejected: { reason: LaborRejectReason; count: number }[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses an hourly-wage cell when the column is mapped and the cell holds a number; blank,
 * unparseable, or unmapped all mean "unknown," never a verified $0 — Toast's standard
 * `TimeEntries` export has no wage column at all, and this must not block importing the shift's
 * actual clock-in/out evidence while that's true. */
function parseOptionalWage(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s()]/g, "");
  if (Number.isNaN(Number(cleaned))) return null;
  return toCents(trimmed);
}

/** Toast's "Labor time entries" export (and equivalents). `hourlyWage` mapping is optional: a
 * missing wage column no longer blocks import — see `parseOptionalWage` and
 * `lib/actions/csvImport.ts`'s wage-review staging for how an unknown wage is kept out of
 * canonical, payroll-affecting `timecards` until the owner resolves it. */
export function parseLaborCsv(rows: Record<string, string>[], mapping: LaborColumnMapping): ParseLaborCsvResult {
  const valid: NormalizedLaborRow[] = [];
  const rejectedCounts = new Map<LaborRejectReason, number>();
  const reject = (reason: LaborRejectReason) => rejectedCounts.set(reason, (rejectedCounts.get(reason) ?? 0) + 1);

  for (const row of rows) {
    const employee = (row[mapping.employee] ?? "").trim();
    const dateRaw = (row[mapping.date] ?? "").trim();
    const clockInRaw = (row[mapping.clockIn] ?? "").trim();
    if (!employee) {
      reject("missing_employee");
      continue;
    }
    if (!clockInRaw || !dateRaw) {
      reject("missing_clock_in");
      continue;
    }
    const date = toDateStr(dateRaw);
    if (!ISO_DATE.test(date)) {
      reject("invalid_date");
      continue;
    }
    const clockOutRaw = (row[mapping.clockOut] ?? "").trim();
    valid.push({
      employee,
      clockIn: toIsoTimestamp(date, clockInRaw),
      clockOut: clockOutRaw ? toIsoTimestamp(date, clockOutRaw) : null,
      hourlyWageCents: mapping.hourlyWage ? parseOptionalWage(row[mapping.hourlyWage] ?? "") : null,
    });
  }

  return { valid, rejected: [...rejectedCounts.entries()].map(([reason, count]) => ({ reason, count })) };
}
