import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {accessCodeHash} from "@/lib/access/access.server";
import {normalizeCode} from "@/lib/access/status";
/** Codes and cafés paginate independently. A bounded history never supplies
 * authoritative capacity, names or access modes for the café controls. */
export async function getAdminCodeConsole(page=0,cafePage=0){
 const safePage=Number.isInteger(page)&&page>=0&&page<=9999?page:0;
 const safeCafePage=Number.isInteger(cafePage)&&cafePage>=0&&cafePage<=9999?cafePage:0;
 const perPage=50,cafePerPage=50;
 const db=createAdminSupabaseClient();
 const [{data:codes,error:cErr,count:codeTotal},{data:redemptions,error:rErr},
   {data:cafes,error:bErr,count:cafeTotal},{data:counts,error:countsErr}]=await Promise.all([
   db.from("free_access_codes").select("id,code_hint,duration_months,fixed_end_date,max_cafes,note,active,created_at",{count:"exact"})
     .order("created_at",{ascending:false}).order("id").range(safePage*perPage,(safePage+1)*perPage-1),
   db.from("free_access_redemptions").select("code_id,business_id,redeemed_by,redeemed_at,access_end")
     .order("redeemed_at",{ascending:false}).limit(500),
   db.from("businesses").select("id,name",{count:"exact"}).order("name").order("id")
     .range(safeCafePage*cafePerPage,(safeCafePage+1)*cafePerPage-1),
   db.rpc("admin_code_redemption_counts"),
 ]);
 if(cErr||rErr||bErr||countsErr)throw cErr??rErr??bErr??countsErr;
 const history=redemptions??[],cafeRows=cafes??[];
 const cafeIds=[...new Set([...cafeRows.map(c=>c.id),...history.map(r=>r.business_id)])];
 const otherCafeIds=[...new Set(history.map(r=>r.business_id))]
   .filter(id=>!cafeRows.some(c=>c.id===id));
 const codeIds=[...new Set(history.map(r=>r.code_id))];
 const batch=(ids:string[])=>Array.from({length:Math.ceil(ids.length/100)},(_,index)=>ids.slice(index*100,(index+1)*100));
 // PostgREST URL sizes stay bounded even for 500 distinct history cafés/codes.
 const [accessPages,historyCafePages,historyCodePages]=await Promise.all([
   Promise.all(batch(cafeIds).map(ids=>db.from("cafe_access")
     .select("business_id,mode,code_id,access_end").in("business_id",ids))),
   Promise.all(batch(otherCafeIds).map(ids=>db.from("businesses").select("id,name").in("id",ids))),
   Promise.all(batch(codeIds).map(ids=>db.from("free_access_codes").select("id,code_hint").in("id",ids))),
 ]);
 for(const result of [...accessPages,...historyCafePages,...historyCodePages])if(result.error)throw result.error;
 const access=accessPages.flatMap(result=>result.data??[]);
 const names=Object.fromEntries([...cafeRows,...historyCafePages.flatMap(result=>result.data??[])]
   .map(c=>[c.id,c.name] as const));
 const hints=Object.fromEntries([...codes??[],...historyCodePages.flatMap(result=>result.data??[])]
   .map(c=>[c.id,c.code_hint] as const));
 const totals=(counts??{}) as Record<string,number>;
 const ownerIds=[...new Set(history.map(r=>r.redeemed_by).filter((x):x is string=>!!x))];
 const emails:readonly (readonly [string,string])[]=await Promise.all(ownerIds.map(async id=>{
  const {data}=await db.auth.admin.getUserById(id);
  return [id,data.user?.email??"Unknown"] as const;
 }));
 const emailById=Object.fromEntries(emails);
 return {page:safePage,perPage,codeTotal:codeTotal??codes?.length??0,
  cafePage:safeCafePage,cafePerPage,cafeTotal:cafeTotal??cafeRows.length,
  codes:(codes??[]).map(c=>({...c,redeemed_cafes:Number(totals[c.id]??0)})),
  redemptions:history.map(r=>({...r,cafeName:names[r.business_id]??r.business_id,
   codeHint:hints[r.code_id]??"—",ownerEmail:emailById[r.redeemed_by??""]??"—"})),
  access,cafes:cafeRows};
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
