import "server-only";
import {AsyncLocalStorage} from "node:async_hooks";
import type {SupabaseClient} from "@supabase/supabase-js";
import {requireSchedulingOwner} from "./foundation.server";

/** This private context can only be opened by the server-owned durable runner.
 * It exists solely for Olivia's read-only preview. Never set request cookies,
 * impersonate a browser session, or pass this context to a writer. */
type DurableScope={client:SupabaseClient;businessId:string;ownerUserId:string;
 threadId:string;runId:string;claimToken:string;jobId:string};
const readScope=new AsyncLocalStorage<DurableScope>();
const readToken=(s:DurableScope)=>s.client.rpc("supervisor_owner_schedule_source_token_v2",{
 p_business_id:s.businessId,p_owner_user_id:s.ownerUserId,p_thread_id:s.threadId,
 p_run_id:s.runId,p_claim_token:s.claimToken,p_job_id:s.jobId,
});
async function assertScope(s:DurableScope){
 const {data,error}=await readToken(s);
 if(error||typeof data!=="string"||!/^[a-f0-9]{32}$/.test(data))throw Error("durable_schedule_scope_unavailable");
}
export async function withDurableOliviaReadScope<T>(scope:DurableScope,preview:()=>Promise<T>):Promise<T>{
 await assertScope(scope);
 return readScope.run(scope,async()=>{
  const result=await preview();
  await assertScope(scope);
  return result;
 });
}
export async function requireOliviaReadOwner(){
 const s=readScope.getStore();
 if(!s)return requireSchedulingOwner();
 await assertScope(s);
 return {supabase:s.client,businessId:s.businessId};
}
export async function readOliviaSourceToken(client:SupabaseClient,businessId:string){
 const s=readScope.getStore();
 if(!s)return client.rpc("scheduling_owner_source_token",{p_business_id:businessId});
 if(client!==s.client||businessId!==s.businessId)throw Error("durable_schedule_scope_mismatch");
 return readToken(s);
}
