import "server-only";

import {z} from "zod";
import {requireSchedulingOwner} from "./foundation.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {PlannerInput,PlannerRuleProfile} from "@/lib/calc/scheduling/plannerTypes";

const integer=(max:number)=>z.number().int().min(0).max(max);
const record=z.record(z.string().uuid(),z.string().trim().min(2).max(120));
export const oliviaReviewedRuleProfileSchema=z.object({
  verified:z.literal(true),
  source:z.string().trim().min(12).max(500),
  jurisdictionByLocationId:record,
  classificationByEmployeeId:record,
  maxContinuousWorkMinutes:integer(1440),
  unpaidMealMinutes:integer(120),
  paidRestMinutes:integer(120),
  minRestBetweenShiftsMinutes:integer(1440),
  overtime:z.object({
    verified:z.literal(true),dailyAfterMinutes:integer(1440),
    weeklyAfterMinutes:integer(10080),
    multiplierNumerator:z.number().int().min(1).max(10),
    multiplierDenominator:z.number().int().min(1).max(10),
  }).strict(),
}).strict();
export const laborReviewCommandSchema=z.object({
  expectedRevision:z.number().int().min(0).max(500),
  requestKey:z.string().uuid(),
  attestation:z.literal(true),
  profile:oliviaReviewedRuleProfileSchema,
}).strict();

export function verifiedOliviaRuleProfile(
  candidate:unknown, input:Pick<PlannerInput,"locations"|"employees">,
):PlannerRuleProfile|null {
  const parsed=oliviaReviewedRuleProfileSchema.safeParse(candidate);
  if(!parsed.success)return null;
  const rules=parsed.data;
  if(!input.locations.every(location=>Boolean(rules.jurisdictionByLocationId[location.id]))||
     !input.employees.filter(e=>e.active).every(employee=>
       Boolean(rules.classificationByEmployeeId[employee.id])))
    return null;
  // This represents a documented OWNER review, never an inferred law.
  // Rechecking the real jurisdiction/contract source remains the owner's duty.
  return rules;
}

export async function readOliviaRuleReview(){
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
     process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  const {data,error}=await owner.supabase.from("scheduling_labor_rule_reviews")
    .select("revision,profile,reviewed_at")
    .eq("business_id",owner.businessId).maybeSingle();
  if(error)return {ok:false as const,error:"storage_unavailable" as const};
  return {ok:true as const,revision:(data?.revision as number|undefined)??0,
    profile:data?.profile??null,reviewedAt:data?.reviewed_at??null};
}

export async function saveOliviaRuleReview(raw:unknown,
  input:Pick<PlannerInput,"locations"|"employees">,sourceBusinessId:string){
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true" ||
     process.env.SCHEDULING_PR3_DRAFTS_ENABLED!=="true")
    return {ok:false as const,error:"disabled" as const};
  const parsed=laborReviewCommandSchema.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid_input" as const};
  if(!verifiedOliviaRuleProfile(parsed.data.profile,input))
    return {ok:false as const,error:"incomplete_rules" as const};
  const owner=await requireSchedulingOwner();
  if(!owner)return {ok:false as const,error:"unauthorized" as const};
  if(owner.businessId!==sourceBusinessId)
    return {ok:false as const,error:"tenant_changed" as const};
  const {data:{user},error:authError}=await owner.supabase.auth.getUser();
  if(authError||!user)return {ok:false as const,error:"unauthorized" as const};
  try {
    const admin=createAdminSupabaseClient();
    const {data,error}=await admin.rpc("scheduling_save_labor_rule_review",{
      p_business_id:owner.businessId,p_actor_id:user.id,
      p_expected_revision:parsed.data.expectedRevision,
      p_profile:parsed.data.profile,p_request_key:parsed.data.requestKey,
    });
    if(error||!data)return {ok:false as const,error:"storage_unavailable" as const};
    const row=data as Record<string,unknown>;
    if(row.error=== "revision_conflict"||row.error==="conflict")
      return {ok:false as const,error:"revision_conflict" as const};
    if(!Number.isSafeInteger(row.revision) ||
       (row.revision as number)<parsed.data.expectedRevision+1 ||
       typeof row.replayed!=="boolean")
      return {ok:false as const,error:"storage_unavailable" as const};
    return {ok:true as const,revision:row.revision as number,
      replayed:row.replayed as boolean};
  } catch {return {ok:false as const,error:"storage_unavailable" as const};}
}
