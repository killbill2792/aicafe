import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ResearchContinuationPort} from "@/lib/ai/supervisor/runs/contracts";

export async function backgroundResearchContinuation(db:SupabaseClient,scope:{
 businessId:string;ownerUserId:string;threadId:string;sourceType:"routine"|"alert"|"operating_task";
 sourceId:string;revision:string;leaseToken:string;
}):Promise<ResearchContinuationPort & {executionDeadline:number;yield:()=>Promise<void>}>{
 const call=async(operation:"load"|"save"|"yield",state:unknown=null)=>{
   const {data,error}=await db.rpc("supervisor_background_research_checkpoint",{
     p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
     p_source_type:scope.sourceType,p_source_id:scope.sourceId,p_revision:scope.revision,
     p_lease_token:scope.leaseToken,p_operation:operation,p_state:state,
   });
   if(error||!data)throw Error("background_research_checkpoint_unavailable");
   return data as {state?:unknown;lease_until?:string;ok?:boolean};
 };
 const initial=await call("load");
 const expiry=Date.parse(initial.lease_until??"");
 if(!Number.isFinite(expiry))throw Error("background_research_checkpoint_invalid_lease");
 return {executionDeadline:Math.min(expiry-10000,Date.now()+110000),
   load:async()=>initial.state??null,
   save:async(state)=>{await call("save",state);},
   yield:async()=>{await call("yield");}};
}
