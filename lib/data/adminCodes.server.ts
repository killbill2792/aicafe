import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {accessCodeHash} from "@/lib/access/access.server";
import {normalizeCode} from "@/lib/access/status";
export async function getAdminCodeConsole(){
 const db=createAdminSupabaseClient();
 const [{data:codes,error:cErr},{data:redemptions,error:rErr},{data:access,error:aErr},{data:cafes,error:bErr}]=await Promise.all([
   db.from("free_access_codes").select("id,code_hint,duration_months,fixed_end_date,max_cafes,note,active,created_at").order("created_at",{ascending:false}).limit(200),
   db.from("free_access_redemptions").select("code_id,business_id,redeemed_by,redeemed_at,access_end").order("redeemed_at",{ascending:false}).limit(500),
   db.from("cafe_access").select("business_id,mode,code_id,access_end").limit(1000),
   db.from("businesses").select("id,name").order("name").limit(1000)
 ]);
 if(cErr||rErr||aErr||bErr)throw cErr??rErr??aErr??bErr;
 const emails=await Promise.all([...new Set((redemptions??[]).map(r=>r.redeemed_by).filter((x):x is string=>!!x))].map(async id=>{
  const {data}=await db.auth.admin.getUserById(id);
  return [id,data.user?.email??"Unknown"] as const;
 }));
 return {codes:codes??[],redemptions:(redemptions??[]).map(r=>({
   ...r,ownerEmail:Object.fromEntries(emails)[r.redeemed_by??""]??"—"})),
   access:access??[],cafes:cafes??[]};
}
export async function insertFreeAccessCode(input:{code:string;durationMonths:number|null;fixedEndDate:string|null;maxCafes:number;note:string;adminId:string}){
 const db=createAdminSupabaseClient();
 const {error}=await db.from("free_access_codes").insert({
  code_hash:accessCodeHash(input.code),code_hint:normalizeCode(input.code).slice(0,5)+"…",
  duration_months:input.durationMonths,fixed_end_date:input.fixedEndDate,
  max_cafes:input.maxCafes,note:input.note||null,created_by:input.adminId,
 });
 if(error?.code==="23505")return "code_exists" as const;
 if(error)throw error;
 return "ok" as const;
}
export async function toggleFreeAccessCode(id:string,active:boolean){
 const {data,error}=await createAdminSupabaseClient().from("free_access_codes")
  .update({active}).eq("id",id).select("id").maybeSingle();
 if(error)throw error;
 return data?"ok" as const:"not_found" as const;
}
export async function changeCafeAccess(input:{businessId:string;action:"extend"|"grandfathered"|"paused";accessEnd?:string}){
 const {data,error}=await createAdminSupabaseClient().rpc("admin_change_cafe_access",{
  p_business_id:input.businessId,p_action:input.action,p_access_end:input.accessEnd??null,
 });
 if(error)throw error;
 return String((data as {status?:string}|null)?.status??"unavailable");
}
