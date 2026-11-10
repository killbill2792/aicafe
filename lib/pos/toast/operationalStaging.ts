import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
import {ToastApiError} from "./client";
type Scope={businessId:string;restaurantGuid:string;deadlineAt?:number};
/** Keep operational errors in the EXISTING owner-facing Toast health row.
 * This must be reconciled after other optional phases, which may independently
 * clear their own last_failure_category. Preserve those unrelated categories.
 */
type SourceHealth={error?:string|null};
export async function reconcileToastOperationalHealth(db:SupabaseClient,p:Scope,
 known?:Record<string,SourceHealth>){
 let states=known;
 if(!states){
  const {data,error}=await db.from("toast_optional_sync_state")
   .select("operational_sources").eq("business_id",p.businessId)
   .eq("restaurant_guid",p.restaurantGuid).maybeSingle();
  if(error)throw new ToastApiError("unavailable");
  const raw=data?.operational_sources;
  states=raw&&typeof raw==="object"&&!Array.isArray(raw)
   ?raw as Record<string,SourceHealth>:{};
 }
 const active=Object.entries(states).find(([,value])=>value&&typeof value==="object"
  &&typeof value.error==="string"&&value.error.length>0);
 const {data:health,error:readError}=await db.from("toast_sync_health")
  .select("last_failure_category").eq("business_id",p.businessId)
  .eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(readError)throw new ToastApiError("unavailable");
 const prior=typeof health?.last_failure_category==="string"
  ?health.last_failure_category:null;
 const unrelated=(prior??"").split("|").filter(x=>x&&!x.startsWith("operational:"));
 if(active)unrelated.push("operational:"+active[0]+":"+active[1].error);
 const next=unrelated.join("|")||null;
 if(next===prior)return;
 const {error:writeError}=await db.from("toast_sync_health").upsert({
  business_id:p.businessId,restaurant_guid:p.restaurantGuid,
  last_attempt_at:new Date().toISOString(),last_failure_category:next
 },{onConflict:"business_id,restaurant_guid"});
 if(writeError)throw new ToastApiError("unavailable");
}

/** Staff and menu facts are source-scoped staging, not canonical wage/recipe edits. */
export async function stageToastRoster(db:SupabaseClient,p:Scope) {
 const adapter=createToastAdapter({db,...p});
 const rows=await adapter.fetchEmployeeRosterFacts();
 if(rows.length>5000)throw new ToastApiError("invalid_response");
 for(let i=0;i<rows.length;i+=500){
  const {error}=await db.rpc("toast_stage_employee_roster",{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_rows:rows.slice(i,i+500)
  });
  if(error)throw new ToastApiError("unavailable");
 }
 return {staged:rows.length,canonicalEmployeesChanged:false,
  ownerCorrectionsPreserved:true};
}
export async function stageToastCatalog(db:SupabaseClient,p:Scope){
 const adapter=createToastAdapter({db,...p});
 const rows=await adapter.fetchCatalogFacts();
 for(let i=0;i<rows.length;i+=500){
  const {error}=await db.rpc("toast_stage_catalog",{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_rows:rows.slice(i,i+500)
  });
  if(error)throw new ToastApiError("unavailable");
 }
 const {error:health}=await db.from("toast_sync_health").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   last_menu_fetch_at:new Date().toISOString(),last_attempt_at:new Date().toISOString()
 },{onConflict:"business_id,restaurant_guid"});
 if(health)throw new ToastApiError("unavailable");
 return {staged:rows.length,items:rows.filter(r=>r.kind==="item").length,
  modifiers:rows.filter(r=>r.kind==="modifier").length,
  canonicalMenuChanged:false,recipeHistoryPreserved:true};
}
