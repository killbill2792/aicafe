import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {RunningCostLine} from "./types";
import {RUNNING_COST_CODES} from "./runningCostCatalog";

/** One SQL calculation for the screens and Luna. Explicit historical cutoffs use
 * the underlying view function; current and observed months use the view directly. */
export async function readRunningCostLines(db:SupabaseClient,businessId:string,monthStart:string,asOf:string,explicit=false):Promise<RunningCostLine[]>{
 const {data,error}=explicit
  ?await db.rpc("running_cost_lines_for_month",{p_business_id:businessId,p_month_start:monthStart,p_as_of:asOf})
  :await db.from("cv_running_cost_months").select("category_code,data")
    .eq("business_id",businessId).eq("business_date",monthStart).eq("as_of_date",asOf);
 if(error)throw error;
 // A missing historical month need not exist in the discoverable view. Its
 // explicit function query is the SAME SQL calculation and can represent no costs.
 if(!explicit&&Array.isArray(data)&&data.length===0)
  return readRunningCostLines(db,businessId,monthStart,asOf,true);
 if(!Array.isArray(data)||data.length>=1000)throw Error("running_cost_source_incomplete");
 const rows=data.map(row=>row.data as RunningCostLine);
 const ids=new Set<string>();
 const daysInMonth=new Date(Date.UTC(Number(monthStart.slice(0,4)),Number(monthStart.slice(5,7)),0)).getUTCDate();
 for(const row of rows){
  if(!row||typeof row.categoryCode!=="string"||ids.has(row.categoryCode)||
     !Number.isSafeInteger(row.amountCents)||typeof row.isMissing!=="boolean"||
     typeof row.isEstimate!=="boolean"||!Array.isArray(row.expenseEvidence)||
     !Array.isArray(row.dailyAllocatedCents)||row.dailyAllocatedCents.length!==daysInMonth||
     row.dailyAllocatedCents.some((day,i)=>day.date!==monthStart.slice(0,7)+"-"+String(i+1).padStart(2,"0")||!Number.isFinite(day.amountCents)))
    throw Error("running_cost_source_incomplete");
  ids.add(row.categoryCode);
 }
 if(RUNNING_COST_CODES.some(code=>!ids.has(code)))throw Error("running_cost_source_incomplete");
 return rows.sort((a,b)=>{
  const rank=(code:string)=>RUNNING_COST_CODES.includes(code as RunningCostLine["categoryCode"])?RUNNING_COST_CODES.indexOf(code as RunningCostLine["categoryCode"]):RUNNING_COST_CODES.length;
  return rank(a.categoryCode)-rank(b.categoryCode)||a.categoryCode.localeCompare(b.categoryCode);
 });
}
