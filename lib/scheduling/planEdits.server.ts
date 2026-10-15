import "server-only";

import { z } from "zod";
import { requireSchedulingOwner } from "./foundation.server";
import { oliviaSnapshotDigest } from "./planDrafts.server";
import { validateOliviaAssignments } from "@/lib/calc/scheduling/plannerValidate";
import type { PlannerInput, PlannerScenario, PlannerShift } from "@/lib/calc/scheduling/plannerTypes";

const uuid = z.string().uuid();
const canonicalUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
const breakSchema = z.object({
  startAt:canonicalUtc, endAt:canonicalUtc, paid:z.boolean(),
}).strict();
const shiftSchema = z.object({
  employeeId:uuid, locationId:uuid, startAt:canonicalUtc,
  endAt:canonicalUtc, paidMinutes:z.number().int().min(0).max(1440),
  breaks:z.array(breakSchema).max(24), pinned:z.boolean(),
}).strict();
export const editDraftSchema = z.object({
  horizonStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedRevision:z.number().int().min(1).max(500),
  baseRevisionId:uuid,
  objective:z.enum(["cash","owner_time","balanced"]),
  requestKey:uuid,
  expectedSourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
  shifts:z.array(shiftSchema).max(200),
}).strict();

export type OliviaEditResult =
  | {ok:true; seriesId:string; revisionId:string; revision:number; replayed:boolean;
      scenario:PlannerScenario}
  | {ok:false;error:"invalid_input"|"unauthorized"|"disabled"|"tenant_changed"|
    "source_changed"|"revision_conflict"|"invalid_shifts"|"capacity_exceeded"|
    "storage_unavailable"; violations?:string[]};

/** A caller can propose employee IDs and shift times ONLY. Wages, coverage,
 * eligibility, authorizations and rules are loaded exclusively from the server.
 * This writes a new INERT draft, never approves or publishes one.
 */
export async function saveOliviaEditedDraft(
  raw:unknown, input:PlannerInput, businessId:string, sourceFingerprint:string,
):Promise<OliviaEditResult> {
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false,error:"disabled"};
  const parsed=editDraftSchema.safeParse(raw);
  if(!parsed.success || parsed.data.horizonStart!==input.horizonStart ||
     !/^[a-f0-9]{64}$/.test(sourceFingerprint))
    return {ok:false,error:"invalid_input"};
  const edit=parsed.data;
  if(edit.objective==="owner_time" &&
    !input.employees.some(employee=>employee.isOwner===true))
    return {ok:false,error:"invalid_input"};
  if(oliviaSnapshotDigest(input,sourceFingerprint)!==edit.expectedSourceDigest)
    return {ok:false,error:"source_changed"};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false,error:"unauthorized"};
  if(owner.businessId!==businessId)return {ok:false,error:"tenant_changed"};
  // Compare against an authoritative saved base revision, not a caller-supplied
  // scenario; the final CAS remains inside the existing atomic draft SQL RPC.
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,current_revision")
    .eq("business_id",businessId).eq("horizon_start",edit.horizonStart)
    .maybeSingle();
  if(seriesError)return {ok:false,error:"storage_unavailable"};
  if(!series || series.current_revision!==edit.expectedRevision)
    return {ok:false,error:"revision_conflict"};
  const {data:base,error:baseError}=await owner.supabase
    .from("scheduling_plan_revisions").select("id,status,source_digest,scenario")
    .eq("business_id",businessId).eq("series_id",series.id)
    .eq("revision",edit.expectedRevision)
    .eq("id",edit.baseRevisionId).maybeSingle();
  if(baseError)return {ok:false,error:"storage_unavailable"};
  if(!base || base.status==="superseded" || !base.scenario ||
     !["draft","approved","published"].includes(String(base.status)))
    return {ok:false,error:"revision_conflict"};
  if(base.source_digest!==edit.expectedSourceDigest)
    return {ok:false,error:"source_changed"};
  const baseline=base.scenario as PlannerScenario;
  if(baseline.objective!==edit.objective || !Array.isArray(baseline.shifts))
    return {ok:false,error:"invalid_input"};

  let validation:ReturnType<typeof validateOliviaAssignments>;
  try {
    validation=validateOliviaAssignments(input,edit.shifts);
  } catch {
    return {ok:false,error:"invalid_shifts"};
  }
  if(!validation.valid || !validation.completeCoverage || !validation.cost ||
      validation.matchingBudgetExhausted)
    return {ok:false,error:"invalid_shifts",
      violations:validation.violations.slice(0,20)};
  // Keep the prior objective but refresh all derived fields from the pure
  // validator. No edited client cost, score, legal clearance or coverage claim.
  const shifts:PlannerShift[]=edit.shifts.map(shift=>({
    employeeId:shift.employeeId,locationId:shift.locationId,
    startAt:shift.startAt,endAt:shift.endAt,paidMinutes:shift.paidMinutes,
    breaks:shift.breaks.map(brk=>({...brk})),pinned:shift.pinned,
  }));
  const scenario:PlannerScenario={
    ...baseline,shifts,gaps:validation.gaps,
    completeCoverage:validation.completeCoverage,
    hardConstraintsSatisfied:validation.valid,
    cost:validation.cost,
    ownerMinutes:validation.cost.ownerMinutes,
    legalReview:"unverified_profile",
    preferencePenalty:0,exploredNodes:0,
  };
  try {
    const {data,error}=await owner.supabase.rpc("scheduling_create_plan_draft",{
      p_business_id:businessId,p_horizon_start:edit.horizonStart,
      p_expected_revision:edit.expectedRevision,p_source_digest:edit.expectedSourceDigest,
      p_planner_input:input,p_scenario:scenario,p_shifts:shifts,
      p_request_key:edit.requestKey,
    });
    if(error || !data)return {ok:false,error:"storage_unavailable"};
    const result=data as Record<string,unknown>;
    if(result.conflict===true)return {ok:false,error:"revision_conflict"};
    if(!uuid.safeParse(result.seriesId).success ||
       !uuid.safeParse(result.revisionId).success ||
       !Number.isSafeInteger(result.revision) ||
       (result.revision as number)!==edit.expectedRevision+1 ||
       typeof result.replayed!=="boolean")
      return {ok:false,error:"storage_unavailable"};
    return {ok:true,seriesId:result.seriesId as string,
      revisionId:result.revisionId as string,revision:result.revision as number,
      replayed:result.replayed as boolean,scenario};
  } catch {
    return {ok:false,error:"storage_unavailable"};
  }
}
