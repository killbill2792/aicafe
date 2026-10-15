import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { requireSchedulingOwner } from "./foundation.server";
import { normalizeSchedulingWallTime, compensationProvenance, type CompensationProvenance } from "@/lib/calc/scheduling/availability";
import type { PlannerEmployee, PlannerInput, PlannerLocation, PlannerShift } from "@/lib/calc/scheduling/plannerTypes";
import { civilDateAdd } from "@/lib/calc/scheduling/plannerClock";
import { workerWageRate, historicalShiftWageKey } from "@/lib/calc/scheduling/plannerCore";
import {verifiedOliviaRuleProfile} from "./planPolicy.server";

/**
 * Trusted owner-scoped input boundary. Never accepts employee, wage, shift,
 * coverage, location or policy facts from a browser or language model.
 * Missing/unconfirmed facts are never silently promoted to verified facts.
 */
export type OliviaNotice = { code:
  | "wage_unknown" | "availability_missing" | "unconfirmed_absence"
  | "coverage_unconfirmed" | "no_active_staff" | "limits_missing"
  | "legacy_schedules" | "policy_unverified" | "source_provisional";
  employeeName?: string };

export type OliviaBlocker = {code: "no_location" | "no_coverage" | "conflicting_limits"; employeeName?: string};

export type OliviaInputResult =
  | { ok: true; input: PlannerInput; businessId: string; sourceFingerprint: string; sourceToken: string; locationNames: Record<string, string>; warnings: string[]; notices: OliviaNotice[]; blockers: OliviaBlocker[] }
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) ||
      !Number.isFinite(Date.parse(week + "T00:00:00Z")) ||
      new Date(week + "T00:00:00Z").toISOString().slice(0, 10) !== week ||
      new Date(week + "T00:00:00Z").getUTCDay() !== 1) {
    return { ok: false, error: "invalid_week" };
  }
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false, error: "unauthorized" };
  const { supabase, businessId } = owner;
  try {
    const {data:tokenBefore,error:tokenBeforeError}=await supabase.rpc(
      "scheduling_owner_source_token",{p_business_id:businessId});
    if(tokenBeforeError || typeof tokenBefore!=="string" ||
      !/^[a-f0-9]{32}$/.test(tokenBefore))
      throw new Error("Cannot verify scheduling source revision");
    const tables = [
      "employees", "locations", "staff_availability_rules",
      "staff_availability_exceptions", "staff_scheduling_preferences",
      "staff_preference_windows", "scheduling_qualification_types",
      "staff_qualifications", "scheduling_coverage_requirements",
      "staff_scheduling_compensation", "staff_schedules",
      "scheduling_labor_rule_reviews",
    ] as const;
    const [results, business] = await Promise.all([
      Promise.all(tables.map(table => scopedRows(supabase, table, businessId))),
      supabase.from("businesses").select("timezone").eq("id", businessId).single(),
    ]);
    if (business.error || !business.data || !str(business.data.timezone)) throw new Error("Missing business timezone");
    // Read the exact published revision for this week, including future shifts.
    // Only assignments that have already STARTED become frozen replan inputs.
    // The current published pointer is also fingerprinted, so an intervening
    // publication invalidates an old preview even when no shift has started.
    // Stable canonical UTC-minute cutoff; the planner rejects sub-minute times.
    const replanAsOf=new Date(Math.floor(Date.now()/60_000)*60_000).toISOString();
    const {data:publishedSeries,error:seriesError}=await supabase
      .from("scheduling_plan_series").select("id,published_revision")
      .eq("business_id",businessId).eq("horizon_start",week).maybeSingle();
    if(seriesError)throw new Error("Cannot read published schedule pointer");
    const publishedRevision=publishedSeries?.published_revision??null;
    let startedPublishedShifts:PlannerShift[]=[];
    const historicalShiftWageRates:NonNullable<PlannerInput["historicalShiftWageRates"]>={};
    if(publishedRevision!==null){
      if(!Number.isSafeInteger(publishedRevision) || publishedRevision<1)
        throw new Error("Corrupt published revision");
      const {data:revision,error:revisionError}=await supabase
        .from("scheduling_plan_revisions").select("id,status,planner_input")
        .eq("business_id",businessId).eq("series_id",publishedSeries!.id)
        .eq("revision",publishedRevision).maybeSingle();
      if(revisionError || !revision || revision.status!=="published")
        throw new Error("Missing published schedule revision");
      const {data:assignments,error:assignmentsError}=await supabase
        .from("scheduling_plan_assignments")
        .select("employee_id,location_id,starts_at,ends_at,paid_minutes,breaks,pinned")
        .eq("business_id",businessId).eq("plan_revision_id",revision.id)
        .order("starts_at",{ascending:true}).limit(201);
      if(assignmentsError || !assignments || assignments.length>200)
        throw new Error("Incomplete published schedule");
      const normalized=assignments.map(a=>{
        const breaks=Array.isArray(a.breaks)?a.breaks:null;
        if(!breaks || typeof a.employee_id!=="string" ||
           typeof a.location_id!=="string" || typeof a.starts_at!=="string" ||
           typeof a.ends_at!=="string" || typeof a.paid_minutes!=="number" ||
           typeof a.pinned!=="boolean")
          throw new Error("Corrupt published shift");
        return {
          employeeId:a.employee_id,locationId:a.location_id,
          startAt:new Date(a.starts_at).toISOString(),
          endAt:new Date(a.ends_at).toISOString(),
          paidMinutes:a.paid_minutes,pinned:a.pinned,
          breaks:breaks.map((item:unknown)=>{
            const value=item as Row;
            if(!value || typeof value.startAt!=="string" ||
               typeof value.endAt!=="string" || typeof value.paid!=="boolean")
              throw new Error("Corrupt published shift break");
            return {startAt:new Date(value.startAt).toISOString(),
              endAt:new Date(value.endAt).toISOString(),paid:value.paid};
          }),
        } satisfies PlannerShift;
      });
      startedPublishedShifts=normalized.filter(s=>s.startAt<=replanAsOf);
      // The immutable published revision stores the ORIGINAL wage snapshot.
      // Never reprice its started shifts with current employee wages.
      if(startedPublishedShifts.length){
        const saved=z.object({
          employees:z.array(z.unknown()),
          historicalShiftWageRates:z.record(z.string(),z.object({
            rateCentsPerHour:z.number().int().nonnegative().safe().nullable(),
            salary:z.boolean(),
          })).optional(),
        }).safeParse(revision.planner_input);
        if(!saved.success)throw new Error("Missing published wage snapshot");
        const savedWage=z.object({
          id:z.string(),
          wage:z.object({
            wage_period:z.string().nullable(),
            wage_amount_cents:z.number().int().nonnegative().safe().nullable(),
            default_hourly_wage_cents:z.number().int().nonnegative().safe().nullable(),
          }),
          provenance:z.enum(["unknown","known_paid","salary_conversion_pending",
            "known_eligible_zero"]),
          eligibleZeroVerified:z.boolean().optional(),
          verifiedSalaryHourlyCents:z.number().int().nonnegative().safe()
            .nullable().optional(),
          verifiedSalaryHoursPerWeek:z.number().positive().max(168)
            .nullable().optional(),
        });
        for(const shift of startedPublishedShifts){
          const key=historicalShiftWageKey(shift);
          // A second/third replan must retain each already-frozen shift's
          // original rate, not the live rate at the most recent publication.
          const carried=saved.data.historicalShiftWageRates?.[key];
          if(carried){
            historicalShiftWageRates[key]=carried;continue;
          }
          // A shift that started only AFTER the previous publication inherits
          // the wage originally snapshotted for that published revision.
          const matching=saved.data.employees
            .filter(e=>e!==null && typeof e==="object" &&
              (e as Row).id===shift.employeeId);
          if(matching.length!==1)throw new Error("Ambiguous published wage snapshot");
          const parsedWage=savedWage.safeParse(matching[0]);
          if(!parsedWage.success)throw new Error("Corrupt published wage snapshot");
          historicalShiftWageRates[key]={
            rateCentsPerHour:workerWageRate(parsedWage.data as PlannerEmployee),
            salary:["month","year"].includes(parsedWage.data.wage.wage_period??""),
          };
        }
      }
    }
    const [{data:tokenAfter,error:tokenAfterError},pointerCheck]=await Promise.all([
      supabase.rpc("scheduling_owner_source_token",{p_business_id:businessId}),
      supabase.from("scheduling_plan_series").select("id,published_revision")
        .eq("business_id",businessId).eq("horizon_start",week).maybeSingle(),
    ]);
    if(tokenAfterError || tokenAfter!==tokenBefore || pointerCheck.error ||
       (pointerCheck.data?.id??null)!==(publishedSeries?.id??null) ||
       (pointerCheck.data?.published_revision??null)!==publishedRevision)
      throw new Error("Scheduling source or published pointer changed during read");
    const rows = Object.fromEntries(tables.map((table, i) => [table, results[i]])) as Record<typeof tables[number], Row[]>;
    const sourceFingerprint = createHash("sha256").update(JSON.stringify({
      businessId,businessTimezone:business.data.timezone,rows,publishedRevision,
      startedPublishedShifts,historicalShiftWageRates,
    })).digest("hex");
    const end = civilDateAdd(week, 6);
    const extendedStart = civilDateAdd(week, -1);
    const extendedEnd = civilDateAdd(end, 1);
    const warnings: string[] = [];
    const notices: OliviaNotice[] = [];
    const warn = (code: OliviaNotice["code"], message: string, employeeName?: string) => {
      warnings.push(message);
      notices.push({code, ...(employeeName ? {employeeName} : {})});
    };
    const blockers: OliviaBlocker[] = [];

    const locations: PlannerLocation[] = rows.locations.map(r => ({
      id: str(r.id), timezone: nullable(r.timezone) || str(business.data.timezone),
    }));
    if (!locations.length) blockers.push({code:"no_location"});
    const locationNames = Object.fromEntries(rows.locations.map(r => [str(r.id), str(r.name)]));
    const activeCodes = new Set(rows.scheduling_qualification_types
      .filter(r => r.active === true).map(r => str(r.code)));
    const compensation = new Map(rows.staff_scheduling_compensation.map(r => [str(r.employee_id), r]));
    const frozenEmployeeIds=new Set(startedPublishedShifts.map(s=>s.employeeId));
    const employees: PlannerEmployee[] = rows.employees.filter(r =>
      r.active===true || frozenEmployeeIds.has(str(r.id))).map(r => {
      const id = str(r.id);
      const preferences = rows.staff_scheduling_preferences.filter(p =>
        str(p.employee_id) === id && confirmed(p) && inPeriod(p, week, end));
      const limitVariants = new Set(preferences.map(p => JSON.stringify([
        p.min_weekly_minutes, p.desired_weekly_minutes,
        p.max_weekly_minutes, p.max_daily_minutes,
      ])));
      if (limitVariants.size > 1) blockers.push({
        code:"conflicting_limits",employeeName:str(r.display_name),
      });
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
      if (provenance === "unknown") warn("wage_unknown",
        "Review wage source and verification for " + str(r.display_name) + ".", str(r.display_name));
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
        warn("availability_missing", "Confirm availability for " + str(r.display_name) +
          "; staff-list membership is not availability.", str(r.display_name));
      }
      if (rows.staff_availability_exceptions.some(p => str(p.employee_id) === id &&
        !confirmed(p) && ["approved_leave", "unavailable", "replace_day"].includes(str(p.exception_type)) &&
        str(p.local_date) >= extendedStart && str(p.local_date) <= extendedEnd))
        warn("unconfirmed_absence", "Unconfirmed absence or leave for " +
          str(r.display_name) + " may affect this plan. Confirm it before relying on a shift.", str(r.display_name));
      return {
        id, displayName: str(r.display_name), active: r.active===true,
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
      blockers.push({code:"no_coverage"});
    if (rows.scheduling_coverage_requirements.some(c => !confirmed(c)))
      warn("coverage_unconfirmed", "Unconfirmed coverage records were excluded from this proposal.");
    if (!employees.length) warn("no_active_staff", "No active staff. Add employees and their confirmed availability.");
    if (!rows.staff_scheduling_preferences.some(p => confirmed(p) && inPeriod(p, week, end)))
      warn("limits_missing", "No confirmed employee hour limits or preferences. Review staffing limits before using a proposal.");
    if (rows.staff_schedules.some(s => s.active === true &&
      str(s.effective_from) <= end && (s.effective_to == null || str(s.effective_to) >= week)))
      warn("legacy_schedules", "Legacy recurring shifts exist. Olivia proposals do not replace them or create attendance; reconcile both before publication.");

    const ruleProfile=verifiedOliviaRuleProfile(
      rows.scheduling_labor_rule_reviews[0]?.profile,{employees,locations});
    // The foundation has no verified owner-to-worker identity; do not infer it.
    // A rule profile exists only after an explicit documented owner review.
    // link. Never invent them, or mislabel a planner proposal as legally cleared.
    if(!ruleProfile)warn("policy_unverified",
      "Labor rules or classifications are unverified. An owner/legal policy review is required before approval and publication.");
    warn("source_provisional", "This is a provisional read across multiple database requests, not a transactionally consistent source snapshot. It must be revalidated before approval or publishing.");
    // Use the coarsest supported grid that can represent every reviewed paid
    // rest and coverage handoff duration. A 10-minute paid rest MUST NOT be
    // passed to a 30-minute solver. Non-5-minute rests fail review earlier.
    const paidRest=ruleProfile?.paidRestMinutes??0;
    const unpaidMeal=ruleProfile?.unpaidMealMinutes??0;
    const wallMinute=(wall:string)=>{
      const [hour,minute]=wall.slice(0,5).split(":").map(Number);
      return hour*60+minute;
    };
    const frozenLengths=startedPublishedShifts.flatMap(s=>[
      (Date.parse(s.endAt)-Date.parse(s.startAt))/60000,
      ...s.breaks.flatMap(x=>[
        (Date.parse(x.startAt)-Date.parse(s.startAt))/60000,
        (Date.parse(x.endAt)-Date.parse(s.startAt))/60000,
        (Date.parse(x.endAt)-Date.parse(x.startAt))/60000,
      ]),
    ]);
    const slotMinutes=([30,15,10,5] as const).find(slot=>
      paidRest%slot===0 && unpaidMeal%slot===0 &&
      frozenLengths.every(n=>n>=0 && n%slot===0) &&
      coverage.every(c=>{
        const start=wallMinute(c.start_local),end=wallMinute(c.end_local);
        const duration=end-start+(c.overnight?1440:0);
        return duration>0 && duration%slot===0 &&
          (c.minOverlapMinutes??0)%slot===0;
      }))??5;
    return {
      ok: true, businessId, sourceFingerprint, sourceToken:tokenAfter, locationNames, input: { horizonStart: week, locations, employees, coverage,
        ...(ruleProfile ? {ruleProfile} : {}),
        pinned: [], startedPublishedShifts, historicalShiftWageRates, replanAsOf,
        slotMinutes, maxNodes: 12000, beamWidth: 24 },
      warnings, notices, blockers,
    };
  } catch {
    // No partial employee/coverage read can ever be treated as complete.
    return { ok: false, error: "storage_unavailable" };
  }
}
