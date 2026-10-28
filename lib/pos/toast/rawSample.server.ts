import "server-only";
import {createHmac,randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import {fromZonedTime} from "date-fns-tz";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";
import {createToastAnalyticsClient} from "./analyticsClient";

type Scope="date"|"window"|"none"|"restaurant"|"id"|"unsupported";
type Entry={endpoint:string;path:string;doc:string;scope:Scope;page?:boolean;source?:string};
const doc=(family:string,operation:string)=>"https://doc.toasttab.com/openapi/"+family+"/operation/"+operation;
const entry=(endpoint:string,path:string,family:string,operation:string,scope:Scope="none",page=false,source?:string):Entry=>
 ({endpoint,path,doc:doc(family,operation),scope,page,source});
/** Explicit inventory; each operation is attempted or recorded as a prerequisite/method gap. */
const configCollections=[
"alternatePaymentTypes","breakTypes","cashDrawers","diningOptions","discounts","menuGroups","menuItems",
"modifierGroups","menus","noSaleReasons","payoutReasons","preModifierGroups","preModifiers","priceGroups",
"printers","restaurantServices","revenueCenters","salesCategories","serviceAreas","serviceCharges","tables",
"taxRates","tipWithholding","voidReasons"
];
const configDetails=configCollections.filter(n=>!["tipWithholding"].includes(n));
export const TOAST_READ_ENDPOINTS:readonly Entry[]=[
 entry("orders/v2/ordersBulk","/orders/v2/ordersBulk","orders","ordersBulkGet","date",true),
 entry("orders/v2/orders/{guid}","/orders/v2/orders/{guid}","orders","ordersGuidGet","id",false,"orders/v2/ordersBulk"),
 entry("orders/v2/payments","/orders/v2/payments","orders","paymentsGet","date"),
 entry("orders/v2/payments/{guid}","/orders/v2/payments/{guid}","orders","paymentsGuidGet","id",false,"orders/v2/payments"),
 entry("menus/v2/menus","/menus/v2/menus","menus","menusGet"),
 entry("menus/v2/metadata","/menus/v2/metadata","menus","metadataGet"),
 entry("menus/v3/menus","/menus/v3/menus","menusv3","menusGet"),
 entry("menus/v3/metadata","/menus/v3/metadata","menusv3","metadataGet"),
 ...configCollections.map(n=>entry("config/v2/"+n,"/config/v2/"+n,"configuration",n+"Get","none",true)),
 ...configDetails.map(n=>entry("config/v2/"+n+"/{guid}","/config/v2/"+n+"/{guid}",
   "configuration",n+"GuidGet","id",false,"config/v2/"+n)),
 entry("labor/v1/employees","/labor/v1/employees","labor","employeesGet"),
 entry("labor/v1/employees/{guid}","/labor/v1/employees/{guid}","labor","employeesGuidGet","id",false,"labor/v1/employees"),
 entry("labor/v1/jobs","/labor/v1/jobs","labor","jobsGet"),
 entry("labor/v1/jobs/{guid}","/labor/v1/jobs/{guid}","labor","jobsGuidGet","id",false,"labor/v1/jobs"),
 entry("labor/v1/shifts","/labor/v1/shifts","labor","shiftsGet","window"),
 entry("labor/v1/shifts/{guid}","/labor/v1/shifts/{guid}","labor","shiftsGuidGet","id",false,"labor/v1/shifts"),
 entry("labor/v1/timeEntries","/labor/v1/timeEntries","labor","timeEntriesGet","window"),
 entry("labor/v1/timeEntries/{guid}","/labor/v1/timeEntries/{guid}","labor","timeEntriesGuidGet","id",false,"labor/v1/timeEntries"),
 entry("cashmgmt/v1/entries","/cashmgmt/v1/entries","cashmanagement","entriesGet","date"),
 entry("cashmgmt/v1/deposits","/cashmgmt/v1/deposits","cashmanagement","depositsGet","date"),
 entry("stock/v1/inventory","/stock/v1/inventory","stock","getInventory"),
 entry("kitchen/v1/export/itemFulfillments","/kitchen/v1/export/itemFulfillments","kitchen","itemFulfillmentsGet","date"),
 entry("kitchen/v1/published/prepStations","/kitchen/v1/published/prepStations","kitchen","prepStationsGet","none",true),
 entry("kitchen/v1/published/prepStations/{guid}","/kitchen/v1/published/prepStations/{guid}","kitchen","prepStationsGuidGet","id",false,"kitchen/v1/published/prepStations"),
 entry("partners/v1/restaurants","/partners/v1/restaurants","partners","restaurantsGet"),
 entry("restaurants/v1/restaurants/{guid}","/restaurants/v1/restaurants/{guid}","restaurants","restaurantsRestaurantGuidGet","restaurant"),
 entry("restaurants/v1/groups/{guid}/restaurants","/restaurants/v1/groups/{guid}/restaurants","restaurants","groupsManagementGroupGuidRestaurantsGet","id",false,"__management_group__"),
 entry("restaurant-availability/v1/availability","/restaurant-availability/v1/availability","rx.availability.service","availabilityGet"),
 entry("packaging/v1/published/packagingConfig","/packaging/v1/published/packagingConfig","packaging","getPackagingConfig"),
 entry("partners/v1/connectedRestaurants","/partners/v1/connectedRestaurants","partners","connectedRestaurantsGet","none",true),
 entry("device-details/v1/device-info","/device-details/v1/device-info","devicedetails","getDeviceInfo"),
 entry("era/v1/restaurants-information","/era/v1/restaurants-information","analytics","getManagementGroupRestaurantsInformation"),
 ...[
  ["era/v1/metrics/{reportRequestGuid}","getMetricsReportingData"],
  ["era/v1/metrics/day/{reportRequestGuid}","getMetricsReportingDataSpecificTimeRange"],
  ["era/v1/check/{reportRequestGuid}","getCheckReportingData"],
  ["era/v1/labor/{reportRequestGuid}","getLaborReportingData"],
  ["era/v1/menu/{reportRequestGuid}","getMenuReportingData"],
  ["era/v1/payout/{reportRequestGuid}","getPayoutSettledDateReportingData"],
  ["era/v1/payout/payments/{reportRequestGuid}","getPayoutPaymentsReportingData"],
  ["era/v1/payout/sales-date/{reportRequestGuid}","getPayoutSalesDateReportingData"],
  ["era/v1/guest/payment/{reportRequestGuid}","getGuestByPaymentDateReportingData"]
 ].map(([p,op])=>entry(p,"/"+p,"analytics",op,"id",false,"__era_report__")),
 ...[
  ["era/v1/metrics/day","postMetricsReportingDataSpecificTimeRange"],
  ["era/v1/metrics","postMetricsReportingData"],
  ["era/v1/check/day","postCheckReportingData"],
  ["era/v1/labor/day","postLaborReportingData"],
  ["era/v1/menu/day","postMenuReportingData"],
  ["era/v1/payout/day","postPayoutSettledDateReportingData"],
  ["era/v1/guest/payments/day","postGuestPaymentsReportingData"]
 ].map(([p,op])=>entry(p,"/"+p,"analytics",op,"unsupported")),
 entry("loyalty/outbound","/loyalty/outbound","loyalty","overview","unsupported"),
 entry("giftcards/outbound","/giftcards/outbound","giftcards","overview","unsupported"),
 entry("tender/outbound","/tender/outbound","tender","overview","unsupported")
] as const;
const ISO=z.iso.date();
const PAGE_CAP=20;
const PAGE_SIZE=100;
const CHUNK_BYTES=180000;
const RESTRICTED=/(?:password|secret|token|credential|authorization|api.?key|session|cookie|signature|passcode|pin$|ssn|social.?security|routing|account.?number|pan$|cvv|cvc|first.?6|last.?4|last.?four|cardholder|card.?network.?id|card.?number|card.?digits|^networkTransactionIdentifier$|customer.?name|guest.?name|employee.?name|patron.?name|magstripe|track.?data|expir|email|phone|mobile|fax|birth|first.?name|last.?name|full.?name|chosen.?name|street|address|postal|zip.?code|latitude|longitude|^lat$|^lon$|^lng$|ip.?address|device.?id)/i;
const FREEFORM=/(?:notes?|memo|comment|message|instructions|^text$|description|receiptText|^tabName$)/i;
const IDENTIFIER=/(?:^customer(?:Id|Guid)$|^guest(?:Id|Guid)$|^loyalty(?:Id|Guid|AccountId)$|^cardPaymentId$|^cardFingerprint$|^cardTokenId$|^paymentCardId$|^cardId$|^networkTransactionIdentifier$|^maskedLoyaltyIdentifier$|^customerIdentifier$|^loyaltyIdentifier$)/i;
const KEY=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
function safeString(s:string){return s.length<=10000&&!/@/.test(s)&&!/(?:\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{13,19}\b)/.test(s);}
export function redactToastRaw(value:unknown,depth=0,key="",hashKey?:string,context=""):unknown{
 if(depth>32)return null;
 if(Array.isArray(value))return value.map(v=>redactToastRaw(v,depth+1,key,hashKey,context));
 if(value&&typeof value==="object"){
  const obj=value as Record<string,unknown>;
  return Object.fromEntries(Object.entries(obj).filter(([k])=>KEY.test(k)||/^[0-9]{1,6}$/.test(k))
   .filter(([k])=>(IDENTIFIER.test(k)||!RESTRICTED.test(k))&&!FREEFORM.test(k))
   .filter(([k])=>!/(?:customer|guest|employee|staff|person|cardholder|loyalty|patron)/i.test(context)||!/(?:^name$|displayName|nickname|^text$)/i.test(k))
   .map(([k,v])=>[k,redactToastRaw(v,depth+1,k,hashKey,/(?:customer|guest|employee|staff|person|cardholder|loyalty|patron)/i.test(k)?k:context)])
   .filter(([k,v])=>v!==undefined));
 }
 if(IDENTIFIER.test(key)||(/^(?:id|guid|referenceId)$/i.test(key)&&/(?:customer|guest|loyalty|card|patron)/i.test(context))){
  if(!hashKey) return undefined;
  if(typeof value!=="string"&&typeof value!=="number")return null;
  return "hmac:"+createHmac("sha256",hashKey).update(String(value)).digest("hex");
 }
 if(typeof value==="string")return safeString(value)?value:"[redacted]";
 return value;
}
export function toastFieldPaths(value:unknown):string[]{
 const out=new Set<string>();
 const walk=(v:unknown,p:string,d:number)=>{
  if(d>32)return;
  if(Array.isArray(v)){if(p)out.add(p+"[]");for(const x of v)walk(x,p+"[]",d+1);}
  else if(v&&typeof v==="object")for(const [k,x] of Object.entries(v)){
   const n=p?p+"."+k:k;out.add(n);walk(x,n,d+1);
  }
 };
 walk(value,"",0);return [...out].sort();
}
function identifierCounts(value:unknown){
 const counts:Record<string,{present:number;filled:number}>={};
 const walk=(v:unknown,path:string,d:number)=>{
  if(d>32)return;
  if(Array.isArray(v)){for(const x of v)walk(x,path+"[]",d+1);return;}
  if(!v||typeof v!=="object")return;
  for(const [k,x] of Object.entries(v)){
   const next=path?path+"."+k:k;
   if(IDENTIFIER.test(k)){
    const s=counts[next]??{present:0,filled:0};
    s.present++;if(x!==null&&x!==undefined&&x!=="")s.filled++;
    counts[next]=s;
   }
   walk(x,next,d+1);
  }
 };
 walk(value,"",0);return counts;
}
function chunks(raw:unknown):unknown[]{
 const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v)??"null","utf8");
 const split=(v:unknown,depth:number):unknown[]=>{
  if(bytes(v)<=CHUNK_BYTES||depth>40)return [v];
  if(Array.isArray(v)){
   const out:unknown[]=[];let batch:unknown[]=[];
   for(const item of v){
    if(bytes(item)>CHUNK_BYTES){
     if(batch.length){out.push(batch);batch=[];}
     for(const piece of split(item,depth+1))out.push([piece]);
    }else if(batch.length&&bytes([...batch,item])>CHUNK_BYTES){out.push(batch);batch=[item];}
    else batch.push(item);
   }
   if(batch.length)out.push(batch);
   return out;
  }
  if(v&&typeof v==="object"){
   const out:unknown[]=[];let batch:Record<string,unknown>={};
   for(const [key,child] of Object.entries(v)){
    const leaf={[key]:child};
    if(bytes(leaf)>CHUNK_BYTES){
     if(Object.keys(batch).length){out.push(batch);batch={};}
     for(const piece of split(child,depth+1))out.push({[key]:piece});
    }else if(Object.keys(batch).length&&bytes({...batch,[key]:child})>CHUNK_BYTES){
     out.push(batch);batch=leaf;
    }else batch[key]=child;
   }
   if(Object.keys(batch).length)out.push(batch);
   return out;
  }
  return [v];
 };
 return split(raw,0);
}
export type ToastRawSampleResult={captured:number;skipped:boolean;failed:number;reason?:"invalid_request"|"no_location"|"busy"|"cooldown"|"db_error"|"missing_hash_key"|"lease_lost";};
const skip=(reason:NonNullable<ToastRawSampleResult["reason"]>,failed=0):ToastRawSampleResult=>({captured:0,skipped:true,failed,reason});
export async function claimToastRawSample(db:Pick<SupabaseClient,"rpc">,businessId:string,restaurantGuid:string,businessDate:string){
 const {data,error}=await db.rpc("toast_claim_raw_sample",{p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_business_date:businessDate});
 if(error)throw new ToastApiError("unavailable");return data===true;
}
function pathFor(s:Entry,day:string,guid:string,id?:string,page=1,token?:string,window?:{start:Date;end:Date}){
 let path=s.path.replace("{guid}",id??guid).replace("{reportRequestGuid}",id??guid);
 const params=new URLSearchParams();
 if(s.scope==="date")
  params.set(s.endpoint==="orders/v2/payments"?"paidBusinessDate":"businessDate",day.replaceAll("-",""));
 if(s.scope==="window"){
  const start=window?.start??new Date(day+"T00:00:00Z");
  const end=window?.end??new Date(start.getTime()+86400000);
  params.set("startDate",decodeURIComponent(toToastTimestamp(start)));
  params.set("endDate",decodeURIComponent(toToastTimestamp(end)));
 }
 if(s.page&&s.endpoint==="orders/v2/ordersBulk"){
  params.set("pageSize",String(PAGE_SIZE));params.set("page",String(page));
 }else if(s.page){
  if(s.endpoint==="partners/v1/connectedRestaurants")params.set("pageSize",String(PAGE_SIZE));
  if(token)params.set("pageToken",token);
 }
 if(params.size)path+="?"+params.toString();
 return path;
}
function discoveredIds(data:unknown):string[]{
 const result=new Set<string>();
 const visit=(v:unknown,depth:number)=>{
  if(depth>12)return;
  if(Array.isArray(v)){for(const item of v)visit(item,depth+1);return;}
  if(!v||typeof v!=="object"){
   if(typeof v==="string"&&GUID.safeParse(v).success)result.add(v);
   return;
  }
  const r=v as Record<string,unknown>;
  for(const k of ["guid","orderGuid","paymentGuid","id"]){
   const val=r[k];if(typeof val==="string"&&GUID.safeParse(val).success)result.add(val);
  }
 };
 visit(data,0);return [...result];
}
export async function captureToastRawSample(businessId:string,businessDate:string,
 db:SupabaseClient=createAdminSupabaseClient()):Promise<ToastRawSampleResult>{
 if(!GUID.safeParse(businessId).success||!ISO.safeParse(businessDate).success||
 businessDate>new Date().toISOString().slice(0,10))return skip("invalid_request");
 const secret=process.env.TOAST_CUSTOMER_HASH_KEY;
 if(!secret||secret.length<32)return skip("missing_hash_key");
 const hashKey=createHmac("sha256",secret).update(businessId).digest("hex");
 let captured=0,failed=0,leaseNonce:string|null=null,reason:ToastRawSampleResult["reason"];
 const captureId=randomUUID();
 try{
  const {data:mappings,error}=await db.from("toast_location_mappings").select("restaurant_guid,toast_time_zone,closeout_hour")
   .eq("business_id",businessId).not("verified_at","is",null)
   .order("restaurant_guid",{ascending:true}).limit(1);
  if(error)return skip("db_error",1);
  if(!mappings?.length)return skip("no_location");
  const guid=String(mappings[0].restaurant_guid);
  const timeZone=typeof mappings[0].toast_time_zone==="string"?mappings[0].toast_time_zone:"UTC";
  const closeout=Number.isInteger(mappings[0].closeout_hour)?mappings[0].closeout_hour:0;
  const clock=String(closeout).padStart(2,"0")+":00:00";
  const dayStart=fromZonedTime(businessDate+"T"+clock,timeZone);
  const nextDate=new Date(businessDate+"T12:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate()+1);
  const dayEnd=fromZonedTime(nextDate.toISOString().slice(0,10)+"T"+clock,timeZone);
  const businessWindow={start:dayStart,end:dayEnd};
  const acquired=await db.rpc("toast_acquire_lease",{p_business_id:businessId,p_restaurant_guid:guid,p_seconds:290});
  if(acquired.error)return skip("db_error",1);
  if(!acquired.data)return skip("busy");
  leaseNonce=String(acquired.data);
  if(!await claimToastRawSample(db,businessId,guid,businessDate))return skip("cooldown");
  const client=createToastClient(db,businessId);
  const deadlineAt=Date.now()+27*60*1000;
  const analytics=createToastAnalyticsClient(db,businessId,deadlineAt);
  let lastRenew=Date.now();
  const known=new Map<string,Set<string>>();
  // Reuse only pre-existing Analytics report identifiers; never POST to create a report.
  try{
   const {data:jobs}=await db.from("toast_analytics_jobs").select("report_request_guid")
    .eq("business_id",businessId).eq("restaurant_guid",guid)
    .eq("business_date",businessDate).limit(20);
   for(const job of jobs??[]){
    const id=job.report_request_guid;
    if(typeof id==="string"&&GUID.safeParse(id).success){
     const found=known.get("__era_report__")??new Set<string>();
     found.add(id);known.set("__era_report__",found);
    }
   }
  }catch{/* Missing optional Analytics configuration is recorded per endpoint. */}
  const hold=async()=>{
   if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
   if(Date.now()-lastRenew>120000){
    const r=await db.rpc("toast_renew_raw_sample_lease",{p_nonce:leaseNonce,p_seconds:290});
    if(r.error||r.data!==true){reason="lease_lost";throw new Error("lease_lost");}
    lastRenew=Date.now();
   }
  };
  const pace=async()=>{await hold();}; // Client enforces Toast's shared rate budget and endpoint-specific pacing.
  const save=async(s:Entry,raw:unknown,status:number|null,page:number|null,
    code:string|null=null,message:string|null=null)=>{
   const safe=redactToastRaw(raw,0,"",hashKey)??{};
   const parts=chunks(safe);
   for(let i=0;i<parts.length;i++){
    await hold();
    const piece=parts[i];
    const {error:err}=await db.from("toast_raw_samples").insert({
     business_id:businessId,restaurant_guid:guid,business_date:businessDate,
     endpoint:s.endpoint,doc_url:s.doc,capture_id:captureId,page_number:page===null?null:page*1000+i,
     http_status:status,item_count:code?0:Array.isArray(piece)?piece.length:1,
     sample:piece,field_paths:toastFieldPaths(piece),
     identifier_counts:i===0?identifierCounts(raw):{},error_code:code,error_message:message
    });
    if(err)failed++;else captured++;
   }
  };
  for(const s of TOAST_READ_ENDPOINTS){
   if(reason==="lease_lost")break;
   if(s.scope==="unsupported"){
    await save(s,{},null,null,"method_not_get","This documented operation requires a non-GET method");
    continue;
   }
   const ids=s.scope==="id"?[...(known.get(s.source??"")??[])]:[undefined];
   if(!ids.length){await save(s,{},null,null,"missing_resource_guid","No eligible identifier for GET");continue;}
   for(const id of ids){
    let nextToken:string|undefined;
    const seenTokens=new Set<string>();
    for(let page=1;page<=(s.page?PAGE_CAP:1);page++){
     try{
      await pace();
      let http=200;
      let token:string|null=null;
      const requestPath=pathFor(s,businessDate,guid,id,page,nextToken,businessWindow);
      const raw=s.endpoint.startsWith("era/v1/")?
        await analytics.getRaw(requestPath).then(result=>{http=result.status;return result.data;}):
        await client.request(requestPath,guid,z.unknown(),
         {deadlineAt,onResponse:info=>{http=info.status;token=info.nextPageToken;}});
      const obj=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
      const list=Array.isArray(raw)?raw:Array.isArray(obj?.results)?obj.results as unknown[]:
        Array.isArray(obj?.data)?obj.data as unknown[]:undefined;
      const set=known.get(s.endpoint)??new Set<string>();
      if(s.endpoint==="orders/v2/payments"&&list){
       for(const item of list)if(typeof item==="string"&&GUID.safeParse(item).success)set.add(item);
      }else if(list)for(const item of list)for(const found of discoveredIds(item))set.add(found);
      known.set(s.endpoint,set);
      if(s.endpoint==="partners/v1/restaurants"&&list){
       const groups=known.get("__management_group__")??new Set<string>();
       for(const item of list){
        if(item&&typeof item==="object"){
         const g=(item as Record<string,unknown>).managementGroupGuid;
         if(typeof g==="string"&&GUID.safeParse(g).success)groups.add(g);
        }
       }
       known.set("__management_group__",groups);
      }
      await save(s,raw,http,s.page?page:1);
      if(!s.page)break;
      if(s.endpoint==="orders/v2/ordersBulk"){
       if(!list||list.length<PAGE_SIZE)break;
      }else{
       const next=token??(typeof obj?.nextPageToken==="string"?obj.nextPageToken:null);
       if(!next||seenTokens.has(next))break;
       seenTokens.add(next);nextToken=next;
      }
      if(page===PAGE_CAP)await save(s,{},null,page,"page_cap","Maximum 20 pages reached");
     }catch(e){
      if(reason==="lease_lost")break;
      const status=e instanceof ToastApiError?e.status??null:null;
      const code=status===204?"no_content":e instanceof ToastApiError?e.toastCode??e.category:"unavailable";
      const message=e instanceof ToastApiError?e.toastMessage??e.category:"unavailable";
      await save(s,{},status,s.page?page:1,code,message);
      break;
     }
    }
    if(reason==="lease_lost")break;
   }
  }
 }catch(e){
  if(reason!=="lease_lost")reason="db_error";
  failed++;
 }finally{
  if(leaseNonce)try{const released=await db.rpc("toast_release_lease",{p_nonce:leaseNonce});if(released.error)failed++;}catch{failed++;}
 }
 return {captured,failed,skipped:captured===0,...(reason?{reason}:{})};
}
