import Papa from "papaparse";

export function detectCsvColumns(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
  return { headers: (parsed.meta.fields ?? []).map((h) => h.trim()), rows: parsed.data as Record<string, string>[] };
}

export function toDateStr(raw: string): string {
  const trimmed = (raw ?? "").trim();
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const [, m, d, y] = us;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return trimmed;
}

/** `/^\d{4}-\d{2}-\d{2}$/` only checks shape — "2026-02-31" and "2026-13-40" match it too. This
 * checks the value is a real calendar date by round-tripping through UTC-safe component math
 * (no `new Date(string)` parsing, which normalizes out-of-range values instead of rejecting
 * them, e.g. rolling Feb 31 into March 3). A row with a shape-valid but nonexistent date must be
 * rejected per-row with `invalid_date`, not sent to Postgres, where it would fail the whole
 * batch insert and surface as an opaque `staging_failed`. */
export function isValidCalendarDate(dateStr: string): boolean {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function toCents(raw: string): number {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  const negative = /^\(.*\)$/.test(cleaned);
  const numeric = Number(cleaned.replace(/[()]/g, ""));
  if (Number.isNaN(numeric)) return 0;
  const c = Math.round(numeric * 100);
  return negative ? -Math.abs(c) : c;
}

/** Handles both "2:30 PM" clock times and full ISO/US datetimes, combined with a business date. */
export function toIsoTimestamp(dateStr: string, rawTime: string): string {
  const trimmed = (rawTime ?? "").trim();
  if (!trimmed) return `${dateStr}T00:00:00`;
  const timeOnly = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (timeOnly) {
    let hour = Number(timeOnly[1]);
    const minute = timeOnly[2];
    const second = timeOnly[3] ?? "00";
    const ampm = timeOnly[4]?.toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    return `${dateStr}T${String(hour).padStart(2, "0")}:${minute}:${second}`;
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return `${dateStr}T00:00:00`;
}
