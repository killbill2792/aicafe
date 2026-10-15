import "server-only";

import { requireSchedulingOwner } from "./foundation.server";
import { normalizeSchedulingWallTime, compensationProvenance, type CompensationProvenance } from "@/lib/calc/scheduling/availability";
import type { PlannerEmployee, PlannerInput, PlannerLocation } from "@/lib/calc/scheduling/plannerTypes";
import { civilDateAdd } from "@/lib/calc/scheduling/plannerClock";

/**
 * Trusted owner-scoped input boundary. Never accepts employee, wage, shift,
 * coverage, location or policy facts from a browser or language model.
 * Missing/unconfirmed facts are never silently promoted to verified facts.
 */
export type OliviaInputResult =
  | { ok: true; input: PlannerInput; warnings: string[]; blockers: string[] }
  | { ok: false; error: "disabled" | "unauthorized" | "invalid_week" | "storage_unavailable" };

const PAGE = 300;
const TABLE_LIMIT = 20_000;
type Row = Record<string, unknown>;
const str = (v: unknown): string => typeof v === "string" ? v : "";
const nullable = (v: unknown): string | null => typeof v === "string" ? v : null;
const minutes = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const confirmed = (v: Row) => v.confirmation === "owner_confirmed";
const inPeriod = (v: Row, start: string, end: string) =>
  str(v.effective_from) <= end && (v.effective_to == null || str(v.effective_to) >= start);

async function scopedRows(
  supabase: NonNullable<Awaited<ReturnType<typeof requireSchedulingOwner>>>["supabase"],
  table: string, businessId: string,
): Promise<Row[]> {
  const out: Row[] = [];
  let last: string | null = null;
  for (;;) {
    let query = supabase.from(table).select("*", { count: "exact" })
      .eq("business_id", businessId).order("id", { ascending: true }).limit(PAGE);
    if (last) query = query.gt("id", last);
    const { data, error, count } = await query;
    if (error || !data || count == null || data.length > PAGE ||
        (data.length < PAGE && count > data.length)) {
      throw new Error("Incomplete Olivia source read: " + table);
    }
    for (const item of data) {
      const row = item as Row;
      const id = str(row.id);
      if (!id || (last && id <= last)) throw new Error("Unstable Olivia source read");
      out.push(row);
      last = id;
    }
    if (out.length > TABLE_LIMIT) throw new Error("Olivia source capacity exceeded");
    if (data.length < PAGE) return out;
  }
}

export async function loadOliviaWeekFromSavedStaff(week: string): Promise<OliviaInputResult> {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_PR3_DRAFTS_ENABLED !== "true") {
    return { ok: false, error: "disabled" };
  }
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(week) ||
      !Number.isFinite(Date.parse(week + "T00:00:00Z")) ||
      new Date(week + "T00:00:00Z").toISOString().slice(0, 10) !== week ||
      new Date(week + "T00:00:00Z").getUTCDay() !== 1) {
    return { ok: false, error: "invalid_week" };
  }
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false, error: "unauthorized" };
  const { supabase, businessId } = owner;
  try {
    const tables = [
      "employees", "locations", "staff_availability_rules",
      "staff_availability_exceptions", "staff_scheduling_preferences",
      "staff_preference_windows", "scheduling_qualification_types",
      "staff_qualifications", "scheduling_coverage_requirements",
      "staff_scheduling_compensation", "staff_schedules",
    ] as const;
    const [results, business] = await Promise.all([
      Promise.all(tables.map(table => scopedRows(supabase, table, businessId))),
      supabase.from("businesses").select("timezone").eq("id", businessId).single(),
    ]);
    if (business.error || !business.data || !str(business.data.timezone)) throw new Error("Missing business timezone");
    const rows = Object.fromEntries(tables.map((table, i) => [table, results[i]])) as Record<typeof tables[number], Row[]>;
    const end = civilDateAdd(week, 6);
    const extendedStart = civilDateAdd(week, -1);
    const extendedEnd = civilDateAdd(end, 1);
    const warnings: string[] = [];
    const blockers: string[] = [];

    const locations: PlannerLocation[] = rows.locations.map(r => ({
      id: str(r.id), timezone: nullable(r.timezone) || str(business.data.timezone),
    }));
    if (!locations.length) blockers.push("Add a café location before generating a schedule.");
    const activeCodes = new Set(rows.scheduling_qualification_types
      .filter(r => r.active === true).map(r => str(r.code)));
    const compensation = new Map(rows.staff_scheduling_compensation.map(r => [str(r.employee_id), r]));
    const employees: PlannerEmployee[] = rows.employees.filter(r => r.active === true).map(r => {
      const id = str(r.id);
      const preferences = rows.staff_scheduling_preferences.filter(p =>
        str(p.employee_id) === id && confirmed(p) && inPeriod(p, week, end));
      const cap = (column: string): number | null => {
        const numbers = preferences.map(p => minutes(p[column])).filter((n): n is number => n != null);
        return numbers.length ? Math.min(...numbers) : null;
      };
      const wage = {
        wage_period: nullable(r.wage_period),
        wage_amount_cents: minutes(r.wage_amount_cents),
        default_hourly_wage_cents: minutes(r.default_hourly_wage_cents),
      };
      const attestation = compensation.get(id);
      const reported = (attestation?.cash_cost_state ?? "unknown") as CompensationProvenance;
      const provenance = compensationProvenance(
        { cash_cost_state: reported }, wage);
      if (provenance === "unknown") warnings.push("Review wage source and verification for " + str(r.display_name) + ".");
      const recurring = rows.staff_availability_rules
        .filter(p => str(p.employee_id) === id && inPeriod(p, extendedStart, extendedEnd))
        .map(p => ({
          location_id: nullable(p.location_id),
          day_of_week: Number(p.day_of_week),
          start_local: normalizeSchedulingWallTime(str(p.start_local)),
          end_local: normalizeSchedulingWallTime(str(p.end_local)),
          overnight: p.overnight === true,
          effective_from: str(p.effective_from), effective_to: nullable(p.effective_to),
          confirmation: p.confirmation as "unconfirmed" | "owner_confirmed",
        }));
      if (!recurring.some(p => p.confirmation === "owner_confirmed") &&
          !rows.staff_availability_exceptions.some(p => str(p.employee_id) === id &&
            confirmed(p) && ["replace_day", "add_available"].includes(str(p.exception_type)) &&
            str(p.local_date) >= extendedStart && str(p.local_date) <= extendedEnd)) {
        warnings.push("Confirm availability for " + str(r.display_name) + "; staff-list membership is not availability.");
      }
      return {
        id, displayName: str(r.display_name), active: true,
        // No canonical owner-to-worker link: never guess isOwner.
        recurring,
        exceptions: rows.staff_availability_exceptions
          .filter(p => str(p.employee_id) === id &&
            str(p.local_date) >= extendedStart && str(p.local_date) <= extendedEnd)
          .map(p => ({
            location_id: nullable(p.location_id), local_date: str(p.local_date),
            exception_type: p.exception_type as "unavailable" | "approved_leave" | "replace_day" | "add_available" | "hours_cap",
            start_local: p.start_local == null ? null : normalizeSchedulingWallTime(str(p.start_local)),
            end_local: p.end_local == null ? null : normalizeSchedulingWallTime(str(p.end_local)),
            overnight: p.overnight === true,
            max_minutes: minutes(p.max_minutes),
            confirmation: p.confirmation as "unconfirmed" | "owner_confirmed",
          })),
        preferences: rows.staff_preference_windows.filter(p =>
          str(p.employee_id) === id && inPeriod(p, extendedStart, extendedEnd))
          .map(p => ({
            day_of_week: Number(p.day_of_week),
            start_local: normalizeSchedulingWallTime(str(p.start_local)),
            end_local: normalizeSchedulingWallTime(str(p.end_local)),
            overnight: p.overnight === true,
            effective_from: str(p.effective_from), effective_to: nullable(p.effective_to),
            preference: p.preference as "prefer" | "avoid",
            strength: p.strength as "soft" | "hard",
            confirmation: p.confirmation as "unconfirmed" | "owner_confirmed",
          })),
        unavailableWeekdays: preferences.map(p => ({
          effective_from: str(p.effective_from), effective_to: nullable(p.effective_to),
          unavailable_weekdays: Array.isArray(p.unavailable_weekdays)
            ? p.unavailable_weekdays.map(Number) : [],
          confirmation: "owner_confirmed" as const,
        })),
        qualifications: rows.staff_qualifications.filter(q => str(q.employee_id) === id &&
          activeCodes.has(str(q.qualification_code))).map(q => ({
          code: str(q.qualification_code), locationId: nullable(q.location_id),
          validFrom: str(q.valid_from), validTo: nullable(q.valid_to),
          confirmed: confirmed(q),
        })),
        minWeeklyMinutes: preferences.length ? Math.max(...preferences.map(p => minutes(p.min_weekly_minutes) ?? 0)) : 0,
        desiredWeeklyMinutes: preferences.length ? (minutes(preferences[0].desired_weekly_minutes)) : null,
        maxWeeklyMinutes: cap("max_weekly_minutes"),
        maxDailyMinutes: cap("max_daily_minutes"),
        wage, provenance,
        eligibleZeroVerified: provenance === "known_eligible_zero" &&
          typeof attestation?.eligibility_reference === "string" &&
          !!attestation.eligibility_verified_by && !!attestation.eligibility_verified_at,
      };
    });

    const coverage: PlannerInput["coverage"] = rows.scheduling_coverage_requirements
      .filter(c => confirmed(c) && (
        c.local_date != null
          ? str(c.local_date) >= week && str(c.local_date) <= end
          : inPeriod(c, week, end)))
      .map(c => ({
        id: str(c.id), locationId: str(c.location_id),
        dayOfWeek: c.day_of_week == null ? null : Number(c.day_of_week),
        localDate: nullable(c.local_date),
        effectiveFrom: nullable(c.effective_from),
        effectiveTo: nullable(c.effective_to),
        start_local: normalizeSchedulingWallTime(str(c.start_local)),
        end_local: normalizeSchedulingWallTime(str(c.end_local)),
        overnight: c.overnight === true,
        minHeadcount: Number(c.min_headcount),
        minOverlapMinutes: Number(c.min_overlap_minutes),
        qualificationCode: nullable(c.qualification_code),
        priority: c.priority as "required" | "advisory",
      }));
    if (!coverage.some(c => c.priority === "required" && c.minHeadcount > 0))
      blockers.push("Enter and confirm required opening/closing or other staff coverage for this week.");
    if (rows.scheduling_coverage_requirements.some(c => !confirmed(c)))
      warnings.push("Unconfirmed coverage records were excluded from this proposal.");
    if (!employees.length) warnings.push("No active staff. Add employees and their confirmed availability.");
    if (rows.staff_schedules.some(s => s.active === true &&
      str(s.effective_from) <= end && (s.effective_to == null || str(s.effective_to) >= week)))
      warnings.push("Legacy recurring shifts exist. Olivia proposals do not replace them or create attendance; reconcile both before publication.");

    // The foundation has no verified per-jurisdiction labor-policy or owner-person
    // link. Never invent them, or mislabel a planner proposal as legally cleared.
    warnings.push("Labor law, worker classifications, break/overtime settings and owner-worker identity are not verified; publication needs independent review.");
    return {
      ok: true, input: { horizonStart: week, locations, employees, coverage,
        pinned: [], slotMinutes: 30, maxNodes: 12000, beamWidth: 24 },
      warnings, blockers,
    };
  } catch {
    // No partial employee/coverage read can ever be treated as complete.
    return { ok: false, error: "storage_unavailable" };
  }
}
