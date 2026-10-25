import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
import {ToastApiError} from "./client";
type Scope={businessId:string;restaurantGuid:string;deadlineAt?:number};
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
