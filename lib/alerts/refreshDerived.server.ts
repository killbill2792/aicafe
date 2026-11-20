import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {cafeToday} from "@/lib/metrics/core/clock";
import {ensureScheduledShiftsThroughDate} from "@/lib/data/materializeSchedule";
import {refreshBusinessAnomalies} from "./businessAnomalies.server";
import {generateAlerts} from "./generate";
import {refreshPriceReviewTasks} from "@/lib/data/operatingTasks";

/** Migration compatibility is intentionally limited to a missing RPC.
 * An outage or rejected scope must not bypass the database admission fence. */
export function derivedRefreshSchemaMissing(error:{code?:string}|null|undefined){
  return error?.code==="PGRST202"||error?.code==="42883";
}
export type DerivedRefreshResult={businessDate:string;alertsCreated:number;deferred?:true};
/** One authority for scheduled refresh and durable post-import wakeups. */
export async function refreshDerivedForBusiness(
  db:SupabaseClient,businessId:string,timezone:string,now:Date=new Date(),
  options:{enqueueOnly?:boolean}={},
):Promise<DerivedRefreshResult>{
  if(!businessId||!timezone)throw new Error("Missing café refresh scope");
  const businessDate=cafeToday(timezone,now);
  const claimed=await db.rpc("supervisor_claim_derived_refresh",{
    p_business_id:businessId,p_admit:!options.enqueueOnly,
  });
  let token:string|null=null;
  if(claimed.error){
    if(!derivedRefreshSchemaMissing(claimed.error))throw new Error("derived_refresh_admission_failed");
    // Code can be rolled out before the separately authorized schema. Keep the
    // existing refresh behavior, with lower fan-out; never call this fenced.
    console.warn("derived_refresh_schema_pending");
  }else if(claimed.data===null){
    return {businessDate,alertsCreated:0,deferred:true};
  }else if(typeof claimed.data?.token==="string"){
    token=claimed.data.token;
  }else throw new Error("derived_refresh_admission_invalid");
  let success=false;
  let pending=false;
  let alertsCreated=0;
  let failure:unknown;
  try{
    await ensureScheduledShiftsThroughDate(db,businessId,timezone,businessDate);
    // Never abandon other independent families just because one throws.
    // Sequential top-level work avoids simultaneous large snapshots.
    const failures:unknown[]=[];
    try{alertsCreated+=(await generateAlerts(db,businessId)).created;}catch(e){failures.push(e);}
    try{await refreshPriceReviewTasks(db,businessId,now);}catch(e){failures.push(e);}
    try{alertsCreated+=await refreshBusinessAnomalies(db,businessId,businessDate,timezone,now);}catch(e){failures.push(e);}
    if(failures.length)throw failures[0];
    success=true;
  }catch(error){failure=error;}
  if(token){
    const done=await db.rpc("supervisor_finish_derived_refresh",{
      p_business_id:businessId,p_token:token,p_success:success,
    });
    if(done.error||done.data?.accepted!==true)throw new Error("derived_refresh_ack_failed");
    pending=done.data.pending===true;
  }
  if(!success)throw failure;
  return {businessDate,alertsCreated,...(pending?{deferred:true as const}:{})};
}
