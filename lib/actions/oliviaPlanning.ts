"use server";

import { z } from "zod";
import { loadOliviaWeekFromSavedStaff, type OliviaBlocker, type OliviaNotice } from "@/lib/scheduling/planInput.server";
import {readSchedulingDemandContext} from "@/lib/scheduling/demandContext.server";
import type {ScheduleDemandEvidence} from "@/lib/calc/scheduling/demandEvidence";
import { createOliviaDraftFromTrustedSnapshot, oliviaSnapshotDigest } from "@/lib/scheduling/planDrafts.server";
import { optimizeOliviaWeek } from "@/lib/calc/scheduling/plannerEngine";
import {oliviaProposalShifts} from "@/lib/calc/scheduling/oliviaProposalShifts";
import {modelUnpaidOwnerWhatIf} from "@/lib/calc/scheduling/plannerOwnerSavings";
import type { PlannerResult } from "@/lib/calc/scheduling/plannerTypes";
import { requireSchedulingOwner } from "@/lib/scheduling/foundation.server";
import { editDraftSchema, saveOliviaEditedDraft } from "@/lib/scheduling/planEdits.server";
import {transitionOliviaPlan} from "@/lib/scheduling/planPublication.server";
import {laborReviewCommandSchema,readOliviaRuleReview,saveOliviaRuleReview} from "@/lib/scheduling/planPolicy.server";
import type { PlannerScenario } from "@/lib/calc/scheduling/plannerTypes";

const args = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
const saveArgs = args.extend({
  objective: z.enum(["cash", "owner_time", "balanced"]),
  expectedRevision: z.number().int().min(0).max(499),
  requestKey: z.string().uuid(),
  expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function previewOliviaWeek(raw: unknown): Promise<
  | { ok: true; plan: PlannerResult; notices: OliviaNotice[]; blockers: OliviaBlocker[]; employees: Record<string,string>; locations: Record<string,string>; locationNames: Record<string,string>; sourceDigest: string; previewRevision: number;
      frozenShiftKeys:string[]; demandEvidence:ScheduleDemandEvidence }
  | { ok: false; error: string; blockers?: OliviaBlocker[] }
> {
  const parsed = args.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const loaded = await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.blockers.length) return {
    ok: false, error: "missing_inputs", blockers: loaded.blockers,
  };
  // Capture the draft head at the start of this proposal. Saving MUST use
  // precisely this revision, never a later history refresh from a co-owner.
  const owner = await requireSchedulingOwner();
  if (!owner || owner.businessId !== loaded.businessId)
    return { ok:false, error:"unauthorized" };
  const head = await owner.supabase.from("scheduling_plan_series")
    .select("current_revision").eq("business_id",loaded.businessId)
    .eq("horizon_start",parsed.data.week).maybeSingle();
  if (head.error || (head.data &&
      (!Number.isSafeInteger(head.data.current_revision) ||
       head.data.current_revision < 0 || head.data.current_revision > 500)))
    return {ok:false,error:"storage_unavailable"};
  const previewRevision = head.data?.current_revision ?? 0;
  try {
    const plan = optimizeOliviaWeek(loaded.input);
    // Historical sales are advisory, and must never affect Olivia's confirmed
    // coverage requirements, solver or mutable source-approval digest.
    const demandEvidence=await readSchedulingDemandContext(parsed.data.week,loaded.businessId,
      loaded.cafeTimezone||loaded.input.locations[0]?.timezone);
    return { ok: true, plan, demandEvidence, notices: loaded.notices, blockers: loaded.blockers,
      employees: Object.fromEntries(loaded.input.employees.map(e => [e.id, e.displayName])),
      locations: Object.fromEntries(loaded.input.locations.map(l => [l.id, l.timezone])),
      locationNames: loaded.locationNames, previewRevision,
      // Authoritative published commitments, not the shift's original pinned bit.
      frozenShiftKeys: (loaded.input.startedPublishedShifts??[]).map(s =>
        JSON.stringify([s.employeeId,s.locationId,s.startAt])),
      sourceDigest: oliviaSnapshotDigest(loaded.input, loaded.sourceFingerprint) };
  } catch {
    return { ok: false, error: "planner_unavailable" };
  }
}

/** Hypothetical named employee absence, with absolutely no persistence.
 * This is NOT a confirmed staffing fact: the owner can evaluate a scenario
 * conversationally without approving a change to employee records.
 * Names are selected only if unique within the authenticated café snapshot. */
const absenceWhatIfArgs=args.extend({
 employeeName:z.string().trim().min(1).max(80),
 weekday:z.number().int().min(0).max(6), // Sunday=0, Monday=1
 // Server-supplied prior owner-choice IDs, never accepted as authority for writes.
 selectedEmployeeIds:z.array(z.uuid()).max(10).optional(),
}).strict();
export async function previewOliviaAbsenceWhatIf(raw:unknown){
 const parsed=absenceWhatIfArgs.safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const {week,employeeName,weekday,selectedEmployeeIds=[]}=parsed.data;
 const loaded=await loadOliviaWeekFromSavedStaff(week);
 if(!loaded.ok)return {ok:false as const,error:loaded.error};
 if(loaded.blockers.length)return {ok:false as const,error:"missing_inputs",
  blockers:loaded.blockers};
 // First match exact saved display name; a unique first name is supported,
 // but a shared first name cannot be guessed into the wrong person's record.
 const normal=(name:string)=>name.trim().replace(/\s+/g," ").toLocaleLowerCase("en");
 const target=normal(employeeName);
 const all=loaded.input.employees;
 const exact=all.filter(e=>normal(e.displayName)===target);
 const matches=exact.length?exact:all.filter(e=>normal(e.displayName).split(" ")[0]===target);
 const previouslyChosen=matches.filter(e=>
   selectedEmployeeIds.includes(e.id));
 if(matches.length!==1&&previouslyChosen.length!==1)return {ok:false as const,
  error:matches.length?"employee_ambiguous":"employee_not_found",
  candidates:matches.slice(0,5).map(e=>({id:e.id,name:e.displayName}))};
 const employee=previouslyChosen.length===1?previouslyChosen[0]:matches[0];
 const localDate=new Date(Date.parse(week+"T12:00:00Z")+
   ((weekday+6)%7)*86400000).toISOString().slice(0,10);
 try{
  const baseline=optimizeOliviaWeek(loaded.input);
  const simulatedInput={...loaded.input,employees:all.map(e=>e.id===employee.id?{
   ...e,exceptions:[...e.exceptions,{
    local_date:localDate,exception_type:"unavailable" as const,
    confirmation:"owner_confirmed" as const,
   }],
  }:e)};
  // owner_confirmed is the existing pure-optimizer's input vocabulary,
  // not a claim about the database. The temporary snapshot is NEVER saved.
  const alternative=optimizeOliviaWeek(simulatedInput);
  const before=baseline.best?.cost.cashWagesCents??null;
  const after=alternative.best?.cost.cashWagesCents??null;
  // A cheaper roster that leaves the café uncovered is not a legitimate
  // savings comparison. Both must be valid complete-coverage alternatives.
  const comparable=baseline.status==="feasible"&&alternative.status==="feasible"&&
    baseline.best?.completeCoverage===true&&alternative.best?.completeCoverage===true&&
    baseline.best.hardConstraintsSatisfied===true&&
    alternative.best.hardConstraintsSatisfied===true;
  const change=comparable&&before!==null&&after!==null&&
    Number.isSafeInteger(after-before)?after-before:null;
  // Explain precisely WHOSE shifts moved, rather than merely supplying a
  // cost number. Compare exact optimizer assignments; no modeled result
  // may be mistaken for saved/published work.
  const key=(shift:{employeeId:string;locationId:string;startAt:string;
   endAt:string;paidMinutes:number;breaks:unknown})=>JSON.stringify([
    shift.employeeId,shift.locationId,shift.startAt,shift.endAt,
    shift.paidMinutes,shift.breaks,
   ]);
  const baselineShifts=baseline.best?.shifts??[];
  const alternativeShifts=alternative.best?.shifts??[];
  const oldKeys=new Set(baselineShifts.map(key));
  const newKeys=new Set(alternativeShifts.map(key));
  const removed=baselineShifts.filter(s=>!newKeys.has(key(s)));
  const added=alternativeShifts.filter(s=>!oldKeys.has(key(s)));
  const timezones=Object.fromEntries(loaded.input.locations.map(l=>[l.id,l.timezone]));
  const names=Object.fromEntries(loaded.input.employees.map(e=>[e.id,e.displayName]));
  const present=(shifts:typeof added)=>oliviaProposalShifts(shifts.slice(0,20),timezones)
   .map(s=>({...s,employeeName:names[s.employee_id]??"Team member"}));
  const rosterChanges={
   removed:present(removed),added:present(added),
   totalRemoved:removed.length,totalAdded:added.length,
   truncated:removed.length>20||added.length>20,
  };
  return {ok:true as const,source:"olivia_hypothetical_absence",
   period:{from:week,to:baseline.horizonEnd},employeeId:employee.id,
   employeeName:employee.displayName,absentDate:localDate,
   hypothetical:true,saved:false,published:false,
   assumptions:["Simulated absence supplied for this scenario only; employee availability was not changed"],
   baseline:{status:baseline.status,completeCoverage:baseline.best?.completeCoverage??false,
    cost:baseline.best?.cost??null,gaps:baseline.best?.gaps??[],shiftCount:baseline.best?.shifts.length??0},
   alternative:{status:alternative.status,
    completeCoverage:alternative.best?.completeCoverage??false,
    cost:alternative.best?.cost??null,gaps:alternative.best?.gaps??[],
    shiftCount:alternative.best?.shifts.length??0},
   changeInModeledCashWagesCents:change,
   laborCostDifferenceKnown:change!==null,
   comparisonCompleteCoverage:comparable,
   rosterChanges,
   warnings:[...new Set([...baseline.warnings,...alternative.warnings])]};
 }catch{
  // A hypothetical absence may conflict with immutable already-started
  // published work. Never hide that by removing or rewriting the shift.
  return {ok:false as const,error:"hypothetical_plan_unavailable"};
 }
}

/** Simulate unpaid owner labor using the same Olivia snapshot + optimizer.
 * Never creates a proposal, saves a draft or assumes owner qualifications.
 */
export async function previewOliviaOwnerSavings(raw:unknown){
 const parsed=args.safeParse(raw);
 if(!parsed.success)return {ok:false as const,error:"invalid_input"};
 const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.week);
 if(!loaded.ok)return {ok:false as const,error:loaded.error};
 if(loaded.blockers.length)return {ok:false as const,error:"missing_inputs",
  blockers:loaded.blockers};
 try{
  return {ok:true as const,source:"olivia_owner_what_if",
   period:{from:parsed.data.week,to:new Date(Date.parse(parsed.data.week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)},
   locations:Object.fromEntries(loaded.input.locations.map(l=>[l.id,l.timezone])),
   ...modelUnpaidOwnerWhatIf(loaded.input),notices:loaded.notices};
 }catch{return {ok:false as const,error:"planner_unavailable"};}
}

/** Saves a revision of a real snapshot. Never trusts preview results or
 * any caller-supplied planner input, employees, wages, assignments or digest.
 */
export async function saveOliviaWeekDraft(raw: unknown) {
  const parsed = saveArgs.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_input" as const };
  const loaded = await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  if (loaded.blockers.length) return { ok: false as const, error: "missing_inputs" as const };
  if (parsed.data.objective === "owner_time" &&
      !loaded.input.employees.some(employee => employee.isOwner === true))
    return { ok: false as const, error: "owner_link_missing" as const };
  // A preview is informative, not authority. Refuse to save a different roster
  // after wages, availability, coverage or selected café facts have changed.
  if (oliviaSnapshotDigest(loaded.input, loaded.sourceFingerprint) !== parsed.data.expectedSourceDigest)
    return { ok: false as const, error: "source_changed" as const };
  return createOliviaDraftFromTrustedSnapshot({
    horizonStart: parsed.data.week,
    objective: parsed.data.objective,
    expectedRevision: parsed.data.expectedRevision,
    requestKey: parsed.data.requestKey,
  }, loaded.input, loaded.businessId, loaded.sourceFingerprint);
}

export async function readOliviaPlanHistory(raw: unknown) {
  const parsed = args.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_input" as const };
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true" ||
      process.env.SCHEDULING_PR3_DRAFTS_ENABLED !== "true")
    return { ok: false as const, error: "disabled" as const };
  const owner = await requireSchedulingOwner();
  if (!owner) return { ok: false as const, error: "unauthorized" as const };
  const { data: series, error } = await owner.supabase
    .from("scheduling_plan_series")
    .select("id,current_revision,published_revision")
    .eq("business_id", owner.businessId)
    .eq("horizon_start", parsed.data.week).maybeSingle();
  if (error) return { ok: false as const, error: "storage_unavailable" as const };
  if (!series) return { ok: true as const, currentRevision: 0, publishedRevision: null,
    revisions: [] as Array<{revision:number;status:string;id:string;created_at:string}> };
  const { data: revisions, error: revisionError } = await owner.supabase
    .from("scheduling_plan_revisions")
    .select("id,revision,status,created_at")
    .eq("business_id", owner.businessId)
    .eq("series_id", series.id)
    .order("revision", { ascending: false }).limit(501);
  if (revisionError || !revisions || revisions.length > 500 ||
      (series.current_revision as number) > 500 ||
      ((series.current_revision as number) > 0 &&
        revisions[0]?.revision !== series.current_revision))
    return { ok: false as const, error: "history_too_large_or_unavailable" as const };
  return { ok: true as const, currentRevision: series.current_revision as number,
    publishedRevision: series.published_revision as number | null, revisions };
}

/** The only new owner write here is an inert, validated, immutable draft.
 * Approval and publication are intentionally absent until atomic DB gates exist.
 */
export async function saveOliviaWeekEdit(raw:unknown) {
  const parsed=editDraftSchema.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.horizonStart);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  if(loaded.blockers.length)return {ok:false as const,error:"missing_inputs" as const};
  return saveOliviaEditedDraft(parsed.data,loaded.input,loaded.businessId,
    loaded.sourceFingerprint);
}

const revisionArgs=args.extend({
  revisionId:z.string().uuid(),
}).strict();

/** Owner-scoped read for selecting and editing an already-persisted draft.
 * Never returns an approval or publication permission token.
 */
export async function readOliviaPlanRevision(raw:unknown) {
  const parsed=revisionArgs.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,current_revision,published_revision")
    .eq("business_id",owner.businessId)
    .eq("horizon_start",parsed.data.week).maybeSingle();
  if(seriesError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!series)return {ok:false as const,error:"not_found" as const};
  const {data:revision,error:revisionError}=await owner.supabase
    .from("scheduling_plan_revisions")
    .select("id,revision,status,scenario,source_digest")
    .eq("business_id",owner.businessId)
    .eq("series_id",series.id)
    .eq("id",parsed.data.revisionId).maybeSingle();
  if(revisionError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!revision)return {ok:false as const,error:"not_found" as const};
  const scenario=revision.scenario as PlannerScenario | null;
  if(!scenario || !Array.isArray(scenario.shifts))
    return {ok:false as const,error:"invalid_record" as const};
  return {ok:true as const,revision:revision.revision as number,
    status:revision.status as string,currentRevision:series.current_revision as number,
    publishedRevision:series.published_revision as number|null,
    scenario,sourceDigest:revision.source_digest as string};
}

export async function approveOliviaWeek(raw:unknown) {
  return transitionOliviaPlan(raw,"approve");
}
export async function publishOliviaWeek(raw:unknown) {
  return transitionOliviaPlan(raw,"publish");
}

/** Published Olivia assignments are explicitly planned shifts, not attendance.
 * No legacy timecards or financial calculations are read or written here.
 */
export async function readOliviaPublishedWeek(raw:unknown) {
  const parsed=args.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,published_revision")
    .eq("business_id",owner.businessId).eq("horizon_start",parsed.data.week)
    .maybeSingle();
  if(seriesError)return {ok:false as const,error:"storage_unavailable" as const};
  if(!series||series.published_revision===null)
    return {ok:true as const,publishedRevision:null,assignments:[]};
  const {data:revision,error:revError}=await owner.supabase
    .from("scheduling_plan_revisions").select("id,revision,status")
    .eq("business_id",owner.businessId).eq("series_id",series.id)
    .eq("revision",series.published_revision).maybeSingle();
  if(revError || !revision || revision.status!=="published")
    return {ok:false as const,error:"storage_unavailable" as const};
  const {data:assignments,error:assignError}=await owner.supabase
    .from("scheduling_plan_assignments")
    .select("id,employee_id,location_id,starts_at,ends_at,paid_minutes,breaks")
    .eq("business_id",owner.businessId)
    .eq("plan_revision_id",revision.id)
    .order("starts_at",{ascending:true}).limit(201);
  if(assignError||!assignments||assignments.length>200)
    return {ok:false as const,error:"storage_unavailable" as const};
  return {ok:true as const,publishedRevision:revision.revision as number,
    assignments};
}

export async function readOliviaLaborRuleContext(raw:unknown){
  const parsed=args.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  const review=await readOliviaRuleReview();
  if(!review.ok)return review;
  return {ok:true as const,reviewRevision:review.revision,
    profile:review.profile,reviewedAt:review.reviewedAt,
    locations:loaded.input.locations.map(loc=>({
      id:loc.id,name:loaded.locationNames[loc.id]??loc.id,
    })),
    employees:loaded.input.employees.map(e=>({id:e.id,name:e.displayName}))};
}
export async function saveOliviaLaborRuleReview(raw:unknown){
  const parsed=z.object({week:args.shape.week,
    review:laborReviewCommandSchema}).strict().safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  const loaded=await loadOliviaWeekFromSavedStaff(parsed.data.week);
  if(!loaded.ok)return {ok:false as const,error:loaded.error};
  // Other missing coverage does not prevent a lawful review of this location
  // or worker rule set; the user must still resolve it before publication.
  return saveOliviaRuleReview(parsed.data.review,loaded.input,loaded.businessId);
}
