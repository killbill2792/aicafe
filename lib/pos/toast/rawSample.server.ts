import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";

const daySchema=z.iso.date();
const LIMIT=5;
// Toast schema keys only. Do not persist arbitrary customer-supplied map keys.
const SAFE_KEY=/^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,6})$/;
const SAFE_STRING=/^(?:type|cardType|cardEntryMode|source|status|paymentStatus|refundStatus|diningOption)$/i;
// Keep new Toast financial/labor totals without enumerating every numeric field.
// Mask numeric identifiers even when their names aren't covered by SENSITIVE.
const PRIVATE_NUMBER=/(?:^id$|(?:Id|Guid|GUID)$|reference$|number$|digits$|code$|pin$|identifier$)/i;
const SENSITIVE=/(?:card(?!Type$|EntryMode$)|token|secret|authorization|password|credential|api.?key|cookie|session|signature|last.?4|last.?four|expir|card.?holder|e.?mail|phone|address|customer|first.?name|last.?name|chosen.?name|full.?name|birth|ssn|social.?security|account.?number|routing|pan|cvv|cvc|track.?data|magstripe|postal|zip.?code|street|city|state|country|ip.?address|device.?id|loyalty|gift.?card|guest|patron|person|buyer|purchaser|notes?|description|display.?name|^name$|^text$|comment|memo|contact|holder|recipient|pin$|security.?code|verification.?code)/i;
/** Fail closed on sensitive names, including unexpected nested Toast fields. */
export function redactToastRaw(value:unknown,depth=0,key=""):unknown {
 if(depth>16)return null;
 if(Array.isArray(value))return value.slice(0,LIMIT).map(v=>redactToastRaw(v,depth+1,key));
 if(value&&typeof value==="object"){
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
   .filter(([key])=>SAFE_KEY.test(key)&&!SENSITIVE.test(key))
   .map(([key,v])=>[key,redactToastRaw(v,depth+1,key)]));
 }
 if(typeof value==="number"&&PRIVATE_NUMBER.test(key))return "[redacted]";
 if(typeof value==="string"){
  // Never persist freeform content or identifiers that might contain customer PII.
  if(!SAFE_STRING.test(key)||value.length>120||/@/.test(value)||/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(value))return "[redacted]";
  return value;
 }
 return value;
}
export function toastFieldPaths(value:unknown):string[] {
 const paths=new Set<string>();
 const walk=(v:unknown,path:string,depth:number)=>{
  if(depth>16)return;
  if(Array.isArray(v)){
   if(path)paths.add(path+"[]");
   for(const item of v)walk(item,path+"[]",depth+1);
  }else if(v&&typeof v==="object"){
   for(const [k,child] of Object.entries(v)){
    const next=path?path+"."+k:k;
    paths.add(next);
    walk(child,next,depth+1);
   }
  }
 };
 walk(value,"",0);
 return [...paths].sort();
}
function clipMenu(value:unknown):unknown {
 if(!value||typeof value!=="object"||Array.isArray(value))return value;
 const v=value as Record<string,unknown>;
 const menus=Array.isArray(v.menus)?v.menus.slice(0,3):[];
 const firstThreeRefs=(refs:unknown)=>refs&&typeof refs==="object"&&!Array.isArray(refs)
  ?Object.fromEntries(Object.entries(refs).slice(0,3)):{};
 const clipGroups=(groups:unknown):unknown[]=>Array.isArray(groups)
  ?groups.slice(0,3).map(g=>{
    if(!g||typeof g!=="object")return g;
    const group=g as Record<string,unknown>;
    return {...group,menuItems:Array.isArray(group.menuItems)?group.menuItems.slice(0,3):[],
      menuGroups:clipGroups(group.menuGroups)};
  }):[];
 return {...v,menus:menus.map(m=>{
   if(!m||typeof m!=="object")return m;
   const menu=m as Record<string,unknown>;
   return {...menu,menuGroups:clipGroups(menu.menuGroups)};
 }),modifierGroupReferences:firstThreeRefs(v.modifierGroupReferences),
  modifierOptionReferences:firstThreeRefs(v.modifierOptionReferences)};
}
type Writer=Pick<SupabaseClient,"from"|"rpc">;
export type ToastRawSampleResult={
 captured:number;skipped:boolean;failed:number;
 reason?:"invalid_request"|"no_location"|"busy"|"cooldown"|"db_error";
};
const skip=(reason:NonNullable<ToastRawSampleResult["reason"]>,failed=0):ToastRawSampleResult=>
 ({captured:0,skipped:true,failed,reason});

export async function claimToastRawSample(db:Writer,businessId:string,restaurantGuid:string,businessDate:string){
 const {data,error}=await db.rpc("toast_claim_raw_sample",{
  p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_business_date:businessDate
 });
 if(error)throw new ToastApiError("unavailable");
 return data===true;
}
/** Never throws: diagnostics cannot disrupt import or cron. */
export async function captureToastRawSample(
 businessId:string,businessDate:string,db:SupabaseClient=createAdminSupabaseClient()
):Promise<ToastRawSampleResult> {
 if(!GUID.safeParse(businessId).success||!daySchema.safeParse(businessDate).success||
  businessDate>new Date().toISOString().slice(0,10))return skip("invalid_request");
 let captured=0,failed=0;
 let leaseNonce:string|null=null;
 try{
  const {data:mappings,error}=await db.from("toast_location_mappings")
   .select("restaurant_guid").eq("business_id",businessId).not("verified_at","is",null)
   .order("restaurant_guid",{ascending:true}).limit(1);
  if(error)return skip("db_error",1);
  if(!mappings?.length)return skip("no_location");
  const guid=mappings[0].restaurant_guid as string;
  const {data:nonce,error:leaseError}=await db.rpc("toast_acquire_lease",{
   p_business_id:businessId,p_restaurant_guid:guid,p_seconds:290
  });
  if(leaseError)return skip("db_error",1);
  if(!nonce)return skip("busy");
  leaseNonce=String(nonce);
  if(!await claimToastRawSample(db,businessId,guid,businessDate))
   return skip("cooldown");
  const client=createToastClient(db,businessId);
  // Bound requests well inside the 290-second shared restaurant lease.
  const deadlineAt=Date.now()+240_000;
  const end=new Date(),start=new Date(end.getTime()-7*86400000);
  const monday=new Date(end);
  monday.setUTCDate(end.getUTCDate()-(end.getUTCDay()+6)%7);
  monday.setUTCHours(0,0,0,0);
  const startDate=businessDate.replaceAll("-","");
  const specs=[
   ["orders/v2/ordersBulk","/orders/v2/ordersBulk?businessDate="+startDate+"&pageSize=5&page=1"],
   ["orders/v2/payments","/orders/v2/payments?paidBusinessDate="+startDate],
   ["labor/v1/timeEntries","/labor/v1/timeEntries?startDate="+toToastTimestamp(start)+"&endDate="+toToastTimestamp(end)],
   ["labor/v1/shifts","/labor/v1/shifts?startDate="+toToastTimestamp(monday)+"&endDate="+toToastTimestamp(new Date(monday.getTime()+7*86400000))],
   ["labor/v1/employees","/labor/v1/employees"],
   ["labor/v1/jobs","/labor/v1/jobs"],
   ["menus/v2/menus","/menus/v2/menus"],
   ["restaurants/v1/restaurants","/restaurants/v1/restaurants/"+guid],
   ["config/v2/diningOptions","/config/v2/diningOptions"],
   ["config/v2/revenueCenters","/config/v2/revenueCenters"],
  ] as const;
  const save=async(endpoint:string,raw:unknown,status:number|null,count:number)=>{
   const sample=redactToastRaw(raw)??{};
   const {error:writeError}=await db.from("toast_raw_samples").insert({
    business_id:businessId,restaurant_guid:guid,endpoint,business_date:businessDate,
    http_status:status,item_count:count,sample,field_paths:toastFieldPaths(sample)
   });
   if(writeError)failed++;else captured++;
  };
  let previousGet=0;
  const pace=async()=>{const ms=Math.max(0,5000-(Date.now()-previousGet));
   if(Date.now()+ms>=deadlineAt)throw new ToastApiError("timeout");
   if(ms>0)await new Promise(resolve=>setTimeout(resolve,ms));previousGet=Date.now();};
  for(const [endpoint,path] of specs){
   try{
    await pace();
    const raw=await client.request(path,guid,z.unknown(),{deadlineAt});
    const rows=Array.isArray(raw)?raw.slice(0,LIMIT):raw;
    const sample=endpoint==="menus/v2/menus"?clipMenu(rows):rows;
    await save(endpoint,sample,200,Array.isArray(raw)?raw.length:1);
    if(endpoint==="orders/v2/payments"&&Array.isArray(raw)){
     for(const item of raw.slice(0,LIMIT)){
      const id=typeof item==="string"?item:null;
      if(!id||!GUID.safeParse(id).success)continue;
      try{
       await pace();
       const detail=await client.request("/orders/v2/payments/"+id,guid,z.unknown(),{deadlineAt});
       await save("orders/v2/payments/{guid}",detail,200,1);
      }catch(e){
       const status=e instanceof ToastApiError?e.status:null;
       await save("orders/v2/payments/{guid}",{},status??null,0);
      }
     }
    }
   }catch(e){
    const status=e instanceof ToastApiError?e.status:null;
    await save(endpoint,{},status??null,0);
   }
  }
 }catch{return {captured,skipped:captured===0,failed:failed+1,reason:"db_error"};}
 finally{
  if(leaseNonce)try{
   const {error:releaseError}=await db.rpc("toast_release_lease",{p_nonce:leaseNonce});
   if(releaseError)failed++;
  }catch{failed++;/* A diagnostic must never throw into cron or the owner route. */}
 }
 return {captured,skipped:false,failed,...(failed>0?{reason:"db_error" as const}:{})};
}
