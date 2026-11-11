import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";
import type {PriorityDecision} from "./contracts";

export type NoticeScope={businessId:string;ownerUserId:string;threadId:string;
  localDate:string;routine?:{id:string;runId:string;leaseToken:string}};
/** One authorized writer: notifyOwner policy -> SQL atomic inbox + chat receipt.
 * The SQL function revalidates membership, thread, source and optional routine
 * lease. It must never claim WhatsApp delivered. */
export async function postPriorityNotice(db:SupabaseClient,scope:NoticeScope,
  decision:PriorityDecision,now:Date):Promise<"posted"|"existing"|"skipped">{
  if(decision.source.businessId!==scope.businessId||
      decision.source.ownerUserId!==scope.ownerUserId)throw new Error("Notice scope mismatch");
  const taskId="priority:"+decision.stableKey;
  const result=await notifyOwner(db,{
    businessId:scope.businessId,ownerUserId:scope.ownerUserId,
    threadId:scope.threadId,taskId,kind:"priority_notice",
    localDate:scope.localDate,important:true,
  },async()=>{
    const write=await db.rpc("post_supervisor_priority_notice",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_source_type:decision.source.sourceType,
      p_source_id:decision.source.sourceId,p_revision_hash:decision.revisionHash,
      p_stable_key:decision.stableKey,p_reason:decision.reason,
      p_as_of:now.toISOString(),
      p_routine_id:scope.routine?.id??null,p_run_id:scope.routine?.runId??null,
      p_lease_token:scope.routine?.leaseToken??null,
    });
    if(write.error)throw write.error;
    return write.data===true;
  });
  if(result.decision!=="posted")return "skipped";
  return result.result?"posted":"existing";
}
