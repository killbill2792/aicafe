import "server-only";
import {createHash} from "node:crypto";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {ownerInputWrites,type OwnerInputWriteScope} from "./writeRegistry.server";
import {pendingOwnerInputSchema,type PendingOwnerInput} from "./contracts";
type Outcome={ok:true;replayed:boolean}|{ok:false;reason:string};
const digest=(pending:PendingOwnerInput)=>createHash("sha256").update(
  JSON.stringify([pending.businessId,pending.questionId,pending.request,pending.answer])
).digest("hex");

/** Durable at-most-once claim, distinct from the price-experiment approval ledger.
 * Two confirmations with different client request keys cannot each write.
 * A crash never retries a possibly-applied domain mutation blindly. */
export async function commitConfirmedOwnerInput(scope:OwnerInputWriteScope,
  raw:PendingOwnerInput):Promise<Outcome>{
  const parsed=pendingOwnerInputSchema.safeParse(raw);
  if(!parsed.success||parsed.data.stage!=="confirm"||!parsed.data.answer||
    parsed.data.businessId!==scope.businessId||
    !ownerInputWrites.prepare(parsed.data.request,parsed.data.answer))
    return {ok:false,reason:"invalid_confirmation"};
  const pending=parsed.data;
  const {identity}=await authorizedOwnerP1();
  if(identity.businessId!==scope.businessId||identity.currency!=="USD")
    return {ok:false,reason:"unauthorized"};
  const admin=createAdminSupabaseClient();
  const record={question_id:pending.questionId,business_id:scope.businessId,
    owner_user_id:scope.ownerUserId,request_digest:digest(pending),state:"started"};
  const claim=await admin.from("supervisor_owner_input_claims").insert(record);
  if(claim.error){
    if(claim.error.code!=="23505")return {ok:false,reason:"claim_unavailable"};
    // Owner/tenant and exact value are bound to this immutable question.
    const previous=await admin.from("supervisor_owner_input_claims")
      .select("business_id,owner_user_id,request_digest,state")
      .eq("question_id",pending.questionId).maybeSingle();
    if(previous.error||!previous.data||
      previous.data.business_id!==scope.businessId||
      previous.data.owner_user_id!==scope.ownerUserId||
      previous.data.request_digest!==record.request_digest)
      return {ok:false,reason:"claim_conflict"};
    // If another request crashed after the domain write, reconcile from the
    // authoritative data. Never call the domain writer again under this ID.
    if(previous.data.state!=="applied"&&previous.data.state!=="started")
      return {ok:false,reason:"prior_attempt_uncertain"};
    if(!(await ownerInputWrites.verify(scope,pending.request,pending.answer!)))
      return {ok:false,reason:"prior_attempt_unverified"};
    if(previous.data.state==="started"){
      const marked=await admin.from("supervisor_owner_input_claims")
        .update({state:"applied",updated_at:new Date().toISOString()})
        .eq("question_id",pending.questionId).eq("business_id",scope.businessId)
        .eq("owner_user_id",scope.ownerUserId).eq("state","started");
      if(marked.error)return {ok:false,reason:"claim_reconciliation_failed"};
    }
    return {ok:true,replayed:true};
  }
  const applied=await ownerInputWrites.apply(scope,pending.request,pending.answer!);
  if(!applied.ok)return applied;
  const marked=await admin.from("supervisor_owner_input_claims")
    .update({state:"applied",updated_at:new Date().toISOString()})
    .eq("question_id",pending.questionId).eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).eq("state","started");
  if(marked.error)return {ok:false,reason:"claim_finalize_unavailable"};
  return {ok:true,replayed:false};
}
