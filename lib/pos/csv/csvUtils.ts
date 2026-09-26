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
