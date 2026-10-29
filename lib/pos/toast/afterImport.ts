import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {refreshDerivedForBusiness} from "@/lib/alerts/refreshDerived.server";

export type DerivedRefresh=(db:SupabaseClient,businessId:string,timezone:string)=>Promise<unknown>;
export type DerivedRefreshModule={refreshDerivedForBusiness:DerivedRefresh};
export type DerivedRefreshStatus={derivedRefreshPending:boolean;derivedRefreshNote:string|null};

/** Refreshes schedules and alerts after a committed import. A static import, so the
 * production bundle includes the refresh (a webpackIgnore'd dynamic path to a .ts
 * source never resolves on the server). Tests may inject a loader.
 * Never expose identifiers, payloads or raw errors in the log. */
export async function afterToastImport(db:SupabaseClient,businessId:string,timezone:string,
 load:()=>Promise<DerivedRefreshModule>=async()=>({refreshDerivedForBusiness}),
):Promise<DerivedRefreshStatus>{
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
