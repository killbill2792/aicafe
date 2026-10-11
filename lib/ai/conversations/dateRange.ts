import { z } from "zod";
import type { CafeStatePeriod } from "@/lib/operating/types";

export const dateSelectionSchema = z.strictObject({
  period: z.enum(["today", "yesterday", "week_to_date", "previous_week", "month_to_date",
    "previous_month", "last_7_days", "last_28_days", "custom"]),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type DateSelection = z.infer<typeof dateSelectionSchema>;

function parseDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid calendar date");
  const parsed = new Date(day + "T12:00:00Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== day)
    throw new Error("Invalid calendar date");
  return parsed;
}
function shift(day: string, days: number) {
  const result = parseDay(day);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function monday(day: string) {
  const weekday = parseDay(day).getUTCDay();
  return shift(day, -((weekday + 6) % 7));
}
function previousMonth(day: string) {
  const [year, month] = day.slice(0, 7).split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const to = shift(day.slice(0, 7) + "-01", -1);
  return { from, to };
}
/** All relative dates anchor to the already-resolved café-local as-of day, not the server clock. */
export function resolveCafeDateRange(selection: DateSelection, asOf: string): CafeStatePeriod {
  parseDay(asOf);
  let from: string, to = asOf;
  switch (selection.period) {
    case "today": from = asOf; break;
    case "yesterday": from = to = shift(asOf, -1); break;
    case "week_to_date": from = monday(asOf); break;
    case "previous_week": to = shift(monday(asOf), -1); from = shift(to, -6); break;
    case "month_to_date": from = asOf.slice(0, 7) + "-01"; break;
    case "previous_month": ({ from, to } = previousMonth(asOf)); break;
    case "last_7_days": from = shift(asOf, -6); break;
    case "last_28_days": from = shift(asOf, -27); break;
    case "custom":
      if (!selection.from || !selection.to) throw new Error("Explicit date range requires both dates");
      from = selection.from; to = selection.to; break;
  }
  const elapsed = (parseDay(to).valueOf() - parseDay(from).valueOf()) / 86_400_000;
  if (from > to || to > asOf || elapsed > 365) throw new Error("Date range outside bounded history");
  return { from, to };
}
export function rangeExpectedDays({from,to}: CafeStatePeriod) {
  return Math.round((parseDay(to).valueOf() - parseDay(from).valueOf()) / 86_400_000) + 1;
}
