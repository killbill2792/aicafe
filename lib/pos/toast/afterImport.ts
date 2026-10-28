import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

export type DerivedRefresh=(db:SupabaseClient,businessId:string,timezone:string)=>Promise<unknown>;
export type DerivedRefreshModule={refreshDerivedForBusiness:DerivedRefresh};
export type DerivedRefreshStatus={derivedRefreshPending:boolean;derivedRefreshNote:string|null};

/** Optional until PR B lands. The computed module path permits TS builds while
 * the B-owned file is absent; B may replace this loader with a static import.
 * Never expose identifiers, payloads or raw errors in the log. */
export async function afterToastImport(db:SupabaseClient,businessId:string,timezone:string,
 load:()=>Promise<DerivedRefreshModule>=async()=>{
  const modulePath="../../alerts/"+"refreshDerived.server";
  return import(/* webpackIgnore: true */ modulePath) as Promise<DerivedRefreshModule>;
 }):Promise<DerivedRefreshStatus>{
 try{
  const loaded=await load();
  if(typeof loaded.refreshDerivedForBusiness!=="function")
   throw new Error("derived_refresh_unavailable");
  await loaded.refreshDerivedForBusiness(db,businessId,timezone);
  return {derivedRefreshPending:false,derivedRefreshNote:null};
 }catch{
  console.warn("toast_derived_refresh_pending");
  return {derivedRefreshPending:true,derivedRefreshNote:"derived_refresh_unavailable"};
 }
}
