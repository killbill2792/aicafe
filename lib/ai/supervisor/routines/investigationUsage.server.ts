import "server-only";
import {randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";
import {modelTokenUsage,standardModelTokenRates,estimateModelCallCostMicros}
  from "@/lib/calc/supervisorTokenCost";
import {ownerModelCallsLimit} from "@/lib/ai/conversations/usage.server";

export type ClaimedInvestigationUsageScope={
  businessId:string;ownerUserId:string;threadId:string;
  sourceType:"alert"|"operating_task";sourceId:string;leaseToken:string;
};
export type InvestigationUsageProblem="owner_quota_reached"|"storage_failed"|null;

/** Reserve a billable model call in SQL BEFORE provider transport. Unlike the
 * owner chat ledger this has NO fabricated owner message. Attempted provider
 * calls consume the same UTC owner quota even on timeout, network failure,
 * worker interruption or invalid model output. Only an actually completed
 * provider response may replace the unknown token totals with measured usage.
 * The queue's SQL lease, owner membership and thread are rechecked per call.
 */
export function meteredInvestigationProvider(
  db:SupabaseClient,scope:ClaimedInvestigationUsageScope,underlying:AgentProvider,
):{provider:AgentProvider;problem:()=>InvestigationUsageProblem}{
  let problem:InvestigationUsageProblem=null;
  const provider:AgentProvider=async function*(params,signal){
    if(problem)throw new Error(problem);
    const attemptId=randomUUID();
    let bytes:number;
    try{bytes=Buffer.byteLength(JSON.stringify(params),"utf8");}
    catch{problem="storage_failed";throw new Error(problem);}
    const outputCap=params.max_output_tokens;
    const requestedModel=params.model;
    if(typeof requestedModel!=="string"||!requestedModel.trim()||
      typeof outputCap!=="number"||!Number.isSafeInteger(outputCap)||
      !Number.isSafeInteger(bytes)||bytes<1||bytes>2_000_000||
      outputCap<1||outputCap>1200){
      problem="storage_failed";throw new Error(problem);
    }
    const {error}=await db.rpc("supervisor_reserve_investigation_model_call",{
      p_attempt_id:attemptId,p_business_id:scope.businessId,
      p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
      p_source_type:scope.sourceType,p_source_id:scope.sourceId,
      p_lease_token:scope.leaseToken,p_model:requestedModel,
      p_input_upper:bytes,p_output_cap:outputCap,
      p_owner_daily_cap:ownerModelCallsLimit(),
    });
    if(error){
      problem=String(error.message??"").includes("owner_usage_limit_reached")?
        "owner_quota_reached":"storage_failed";
      throw new Error(problem);
    }
    // A successfully reserved attempt is durable even if the provider fails.
    // Do not retry an uncertain network call with the same attempt ID.
    for await(const event of underlying(params,signal)){
      if(event.type==="response.completed"){
        const resp=event.response as {model?:unknown;service_tier?:unknown;
          usage?:unknown}|undefined;
        const model=typeof resp?.model==="string"&&resp.model.trim()?
          resp.model:requestedModel;
        const usage=modelTokenUsage(resp?.usage);
        const rates=usage?standardModelTokenRates(model,resp?.service_tier??null,
          usage.inputTokens):null;
        const cost=usage&&rates?estimateModelCallCostMicros(usage,rates):null;
        const completed=await db.rpc("supervisor_complete_investigation_model_call",{
          p_attempt_id:attemptId,p_business_id:scope.businessId,
          p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
          p_model:model,p_input_tokens:usage?.inputTokens??null,
          p_output_tokens:usage?.outputTokens??null,
          p_estimated_cost_micros:cost,
        });
        if(completed.error){problem="storage_failed";throw new Error(problem);}
      }
      yield event;
    }
  };
  return {provider,problem:()=>problem};
}
