import "server-only";

import {z} from "zod";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSchedulingOwner} from "./foundation.server";
import {loadOliviaWeekFromSavedStaff} from "./planInput.server";
import {oliviaSnapshotDigest} from "./planDrafts.server";
import {editDraftSchema} from "./planEdits.server";
import {validateOliviaAssignments} from "@/lib/calc/scheduling/plannerValidate";
import type {PlannerShift} from "@/lib/calc/scheduling/plannerTypes";

export const transitionSchema=z.object({
  week:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  revisionId:z.string().uuid(),
  expectedRevision:z.number().int().min(1).max(500),
  requestKey:z.string().uuid(),
}).strict();
type Transition="approve"|"publish";
export type OliviaTransitionResult=
  | {ok:true;revisionId:string;revision:number;status:"approved"|"published";replayed:boolean}
  | {ok:false;error:"disabled"|"unauthorized"|"invalid_input"|"missing_inputs"|
      "source_changed"|"revision_conflict"|"policy_unverified"|
      "invalid_shifts"|"legacy_conflict"|"published_overlap"|"past_shift"|
      "not_approved"|"storage_unavailable"|"conflict"};

const shiftsSchema=editDraftSchema.shape.shifts;
const iso=(value:string)=>new Date(value).toISOString();
function canonicalAssignment(row:Record<string,unknown>) {
  if(typeof row.employee_id!=="string"||typeof row.location_id!=="string"||
     typeof row.starts_at!=="string"||typeof row.ends_at!=="string")
    throw new Error("corrupt_assignment");
  return {employeeId:row.employee_id,locationId:row.location_id,
    startAt:iso(row.starts_at),endAt:iso(row.ends_at),
    paidMinutes:row.paid_minutes,breaks:row.breaks,pinned:row.pinned};
}
function identity(shifts:readonly PlannerShift[]):string {
  return JSON.stringify(shifts.map(s=>({...s,
    breaks:s.breaks.map(b=>({...b}))})).sort((a,b)=>
    a.employeeId.localeCompare(b.employeeId)||a.startAt.localeCompare(b.startAt)||
    a.locationId.localeCompare(b.locationId)));
}

/** Invariant: no browser can call the privileged transition RPC.
 * The server independently authenticates the actor, reloads canonical facts,
 * validates the persisted assignments and verifies a DB source token. The
 * service-role SQL transaction then locks source tables and verifies that token
 * again before committing a version state change.
 */
export async function transitionOliviaPlan(raw:unknown,kind:Transition):
  Promise<OliviaTransitionResult> {
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true"||
     process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true"||
     process.env.SCHEDULING_PR3_PUBLICATION_ENABLED!=="true")
    return {ok:false,error:"disabled"};
  const parsed=transitionSchema.safeParse(raw);
  if(!parsed.success)return {ok:false,error:"invalid_input"};
  const options=parsed.data;
  const loaded=await loadOliviaWeekFromSavedStaff(options.week);
  if(!loaded.ok)return {ok:false,error:loaded.error==="unauthorized"?
    "unauthorized":"storage_unavailable"};
  if(loaded.blockers.length)return {ok:false,error:"missing_inputs"};
  // Never assert that an unsourced legal profile was verified. The current
  // no-POS loader does not yet carry a verified jurisdiction-specific profile.
  if(!loaded.input.ruleProfile?.verified || !loaded.input.ruleProfile.source ||
    !loaded.input.ruleProfile.overtime?.verified)
    return {ok:false,error:"policy_unverified"};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false,error:"unauthorized"};
  if(owner.businessId!==loaded.businessId)return {ok:false,error:"source_changed"};
  const auth=await owner.supabase.auth.getUser();
  const actor=auth.data.user?.id;
  if(auth.error||!actor)return {ok:false,error:"unauthorized"};
  const {data:series,error:seriesError}=await owner.supabase
    .from("scheduling_plan_series").select("id,current_revision,published_revision")
    .eq("business_id",loaded.businessId).eq("horizon_start",options.week)
    .maybeSingle();
  if(seriesError)return {ok:false,error:"storage_unavailable"};
  if(!series||series.current_revision!==options.expectedRevision)
    return {ok:false,error:"revision_conflict"};
  const {data:revision,error:revError}=await owner.supabase
    .from("scheduling_plan_revisions")
    .select("id,revision,status,scenario,source_digest")
    .eq("business_id",loaded.businessId).eq("series_id",series.id)
    .eq("id",options.revisionId).eq("revision",options.expectedRevision)
    .maybeSingle();
  if(revError)return {ok:false,error:"storage_unavailable"};
  if(!revision)return {ok:false,error:"revision_conflict"};
  if(kind==="approve" && !["draft","approved"].includes(String(revision.status)))
    return {ok:false,error:"revision_conflict"};
  if(kind==="publish" && !["approved","published"].includes(String(revision.status)))
    return {ok:false,error:"not_approved"};
  const digest=oliviaSnapshotDigest(loaded.input,loaded.sourceFingerprint);
  if(revision.source_digest!==digest)return {ok:false,error:"source_changed"};
  const scenario=revision.scenario as Record<string,unknown>|null;
  if(!scenario || scenario.legalReview!=="verified_profile" ||
      scenario.completeCoverage!==true || scenario.hardConstraintsSatisfied!==true)
    return {ok:false,error:"policy_unverified"};
  const parsedShifts=shiftsSchema.safeParse(scenario.shifts);
  if(!parsedShifts.success)return {ok:false,error:"invalid_shifts"};
  const shifts=parsedShifts.data;
  const {data:rows,error:assignError}=await owner.supabase
    .from("scheduling_plan_assignments")
    .select("employee_id,location_id,starts_at,ends_at,paid_minutes,breaks,pinned")
    .eq("business_id",loaded.businessId).eq("plan_revision_id",options.revisionId)
    .limit(201);
  if(assignError||!rows)return {ok:false,error:"storage_unavailable"};
  if(rows.length!==shifts.length)return {ok:false,error:"invalid_shifts"};
  try {
    const stored=rows.map(x=>canonicalAssignment(x as Record<string,unknown>)) as PlannerShift[];
    if(identity(stored)!==identity(shifts))
      return {ok:false,error:"invalid_shifts"};
    const validation=validateOliviaAssignments(loaded.input,shifts);
    if(!validation.valid||!validation.completeCoverage||
       validation.matchingBudgetExhausted)
      return {ok:false,error:"invalid_shifts"};
  } catch {return {ok:false,error:"invalid_shifts"};}
  // The source fingerprint alone is not an authority token: only the DB
  // transaction's second check under SHARE locks can authorize a transition.
  try {
    const admin=createAdminSupabaseClient();
    const {data,error}=await admin.rpc(kind==="approve"?
      "scheduling_pr3_approve":"scheduling_pr3_publish",{
      p_business_id:loaded.businessId,p_actor_id:actor,
      p_revision_id:options.revisionId,p_expected_revision:options.expectedRevision,
      p_source_digest:digest,p_source_token:loaded.sourceToken,
      p_request_key:options.requestKey,
    });
    if(error||!data)return {ok:false,error:"storage_unavailable"};
    const result=data as Record<string,unknown>;
    if(result.error!==undefined){
      const supported=["unauthorized","invalid_input","revision_conflict",
        "source_changed","policy_unverified","not_approved","legacy_conflict",
        "published_overlap","past_shift","conflict"] as const;
      return {ok:false,error:supported.find(x=>x===result.error)??"storage_unavailable"};
    }
    if(result.revisionId!==options.revisionId ||
       result.revision!==options.expectedRevision ||
       result.status!==(kind==="approve"?"approved":"published") ||
       typeof result.replayed!=="boolean")
      return {ok:false,error:"storage_unavailable"};
    // Read-back must confirm the transition; an RPC response is insufficient.
    const {data:verify,error:verifyError}=await owner.supabase
      .from("scheduling_plan_revisions").select("status,approved_by,published_by")
      .eq("business_id",loaded.businessId).eq("id",options.revisionId)
      .maybeSingle();
    if(verifyError||!verify||verify.status!==result.status||
       (kind==="approve"?verify.approved_by:verify.published_by)==null)
      return {ok:false,error:"storage_unavailable"};
    if(kind==="publish"){
      const {data:published,error:publishedError}=await owner.supabase
        .from("scheduling_plan_series").select("published_revision")
        .eq("business_id",loaded.businessId).eq("id",series.id).maybeSingle();
      if(publishedError||published?.published_revision!==options.expectedRevision)
        return {ok:false,error:"storage_unavailable"};
    }
    return {ok:true,revisionId:options.revisionId,
      revision:options.expectedRevision,status:kind==="approve"?"approved":"published",
      replayed:result.replayed as boolean};
  } catch {return {ok:false,error:"storage_unavailable"};}
}
