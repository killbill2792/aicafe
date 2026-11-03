import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireAdmin} from "@/lib/admin/auth.server";
import {parseFindings,planBytes,type HealthFinding} from "@/lib/admin/dataHealth";

type Db=ReturnType<typeof createAdminSupabaseClient>;

/** Runs today's check (one row per UTC day, re-running replaces it). Logs counts only. */
export async function runDataHealthCheck(db:Db){
  const {data,error}=await db.rpc("run_data_health_check",{p_plan_bytes:planBytes(process.env.DATABASE_PLAN_BYTES),p_days:30});
  if(error||!data){console.error("data_health_check_failed",{code:error?.code??null});throw new Error("data_health_unavailable");}
  const row=data as {checked_on:string;database_bytes:number;findings:unknown};
  const {known,unknown}=parseFindings(row.findings);
  const counts:Record<string,number>={};
  for(const f of known)counts[f.kind]=(counts[f.kind]??0)+1;
  console.info("data_health_check",{day:row.checked_on,databaseBytes:row.database_bytes,findings:counts,unknown});
  return {day:row.checked_on,databaseBytes:row.database_bytes,findings:known.length+unknown};
}

export type DataHealthDay={checkedOn:string;checkedAt:string;databaseBytes:number;planBytes:number;
  largestTables:{table:string;bytes:number}[];findings:HealthFinding[];unknownFindings:number};
/** Admin only: the latest daily checks, newest first, with café names for the findings. */
export async function readDataHealth(limit=14):Promise<{days:DataHealthDay[];cafeNames:Record<string,string>}>{
  await requireAdmin();
  const db=createAdminSupabaseClient();
  const {data,error}=await db.from("data_health_checks")
    .select("checked_on,checked_at,database_bytes,plan_bytes,largest_tables,findings")
    .order("checked_on",{ascending:false}).limit(limit);
  if(error)throw new Error("data_health_unavailable");
  const days=(data??[]).map(r=>{
    const {known,unknown}=parseFindings(r.findings);
    const tables=Array.isArray(r.largest_tables)?r.largest_tables as {table:string;bytes:number}[]:[];
    return {checkedOn:r.checked_on,checkedAt:r.checked_at,databaseBytes:Number(r.database_bytes),
      planBytes:Number(r.plan_bytes),largestTables:tables,findings:known,unknownFindings:unknown};
  });
  const ids=[...new Set(days.flatMap(d=>d.findings.flatMap(f=>"business_id" in f?[f.business_id]:[])))];
  const cafeNames:Record<string,string>={};
  if(ids.length){
    const names=await db.from("businesses").select("id,name").in("id",ids);
    if(names.error)throw new Error("data_health_unavailable");
    for(const b of names.data??[])cafeNames[b.id]=b.name;
  }
  return {days,cafeNames};
}
