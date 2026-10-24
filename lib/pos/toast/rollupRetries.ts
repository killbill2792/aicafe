import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {recomputeDailyRollup} from "../rollup";

type Job={business_id:string;business_date:string;generation:string};

/** Retry only the post-import cost computation, never the committed Toast day. */
export async function retryToastRollupRefreshes(
 db:SupabaseClient,deadlineAt:number,limit=20
):Promise<{processed:number;deferred:number}> {
 if(Date.now()>=deadlineAt)return {processed:0,deferred:0};
 const {data:jobs,error}=await db.from("toast_rollup_refresh_jobs")
  .select("business_id,business_date,generation")
  .lte("retry_at",new Date().toISOString())
  .order("retry_at",{ascending:true}).limit(limit);
 if(error)throw new Error("Toast cost refresh queue unavailable");
 let processed=0,deferred=0;
 for(const job of (jobs??[]) as Job[]){
  if(Date.now()>=deadlineAt)break;
  const args={p_business_id:job.business_id,p_business_date:job.business_date,
   p_generation:job.generation};
  try{
   const {data:rollup,error:rollupError}=await db.from("daily_rollups")
    .select("sales_data_status").eq("business_id",job.business_id)
    .eq("business_date",job.business_date).maybeSingle();
   if(rollupError||!rollup||!["actual","missing"].includes(rollup.sales_data_status))
    throw new Error("Toast sales coverage missing");
   await recomputeDailyRollup(db,job.business_id,job.business_date,{
    salesDataStatus:rollup.sales_data_status as "actual"|"missing"
   });
   const {error:ackError}=await db.rpc("toast_ack_rollup_refresh",args);
   if(ackError)throw new Error("Toast cost refresh ack failed");
   processed++;
  }catch{
   const {error:deferError}=await db.rpc("toast_defer_rollup_refresh",{
    ...args,p_category:"unavailable"});
   if(deferError)throw new Error("Toast cost refresh checkpoint unavailable");
   deferred++;
  }
 }
 return {processed,deferred};
}
