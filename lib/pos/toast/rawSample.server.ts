import "server-only";
import {createHmac} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";

type Scope="date"|"window"|"none"|"restaurant"|"id"|"unsupported";
type Entry={endpoint:string;path:string;doc:string;scope:Scope;page?:boolean;source?:string};
const doc=(family:string,operation:string)=>"https://doc.toasttab.com/openapi/"+family+"/operation/"+operation;
const entry=(endpoint:string,path:string,family:string,operation:string,scope:Scope="none",page=false,source?:string):Entry=>
 ({endpoint,path,doc:doc(family,operation),scope,page,source});
/** Explicit inventory; each operation is attempted or recorded as a prerequisite/method gap. */
export const TOAST_READ_ENDPOINTS:readonly Entry[]=[
 entry("orders/v2/ordersBulk","/orders/v2/ordersBulk","orders","ordersBulk","date",true),
 entry("orders/v2/orders/{guid}","/orders/v2/orders/{guid}","orders","getOrderByGuid","id",false,"orders/v2/ordersBulk"),
 entry("orders/v2/payments","/orders/v2/payments","orders","listPayments","date"),
 entry("orders/v2/payments/{guid}","/orders/v2/payments/{guid}","orders","getPaymentByGuid","id",false,"orders/v2/payments"),
 entry("menus/v2/menus","/menus/v2/menus","menus","getMenus"),
 entry("menus/v2/metadata","/menus/v2/metadata","menus","getMenusMetadata"),
 entry("menus/v3/menus","/menus/v3/menus","menus","getMenusV3"),
 entry("menus/v3/metadata","/menus/v3/metadata","menus","getMenusMetadataV3"),
 ...["menus","menuGroups","menuItems","menuOptionGroups","preModifiers","premodifiers","discounts","serviceCharges",
 "taxRates","salesCategories","diningOptions","revenueCenters","alternatePaymentTypes","voidReasons","noSaleReasons",
 "cashDrawers","tables","serviceAreas","priceGroups","restaurantServices","tipWithholding","breakTypes",
 "printers","kitchenStations","paymentOptions"].map(name=>entry("config/v2/"+name,"/config/v2/"+name,"configuration","get"+name[0].toUpperCase()+name.slice(1))),
 entry("labor/v1/employees","/labor/v1/employees","labor","getEmployees"),
 entry("labor/v1/jobs","/labor/v1/jobs","labor","getJobs"),
 entry("labor/v1/shifts","/labor/v1/shifts","labor","getShifts","window"),
 entry("labor/v1/timeEntries","/labor/v1/timeEntries","labor","getTimeEntries","window"),
 entry("cashmgmt/v1/entries","/cashmgmt/v1/entries","cash-management","getCashEntries","window"),
 entry("cashmgmt/v1/deposits","/cashmgmt/v1/deposits","cash-management","getDeposits","window"),
 entry("stock/v1/inventory","/stock/v1/inventory","stock","getInventory"),
 entry("kitchen/v1/itemFulfillments","/kitchen/v1/itemFulfillments","kitchen","exportItemFulfillments","date",true),
 entry("restaurants/v1/restaurants/{guid}","/restaurants/v1/restaurants/{guid}","restaurants","getRestaurant","restaurant"),
 entry("restaurants/v1/restaurants","/restaurants/v1/restaurants","restaurants","getRestaurants"),
 entry("restaurant-availability/v1/availability","/restaurant-availability/v1/availability","restaurant-availability","getAvailability"),
 entry("packaging/v1/packaging","/packaging/v1/packaging","packaging","getPackaging"),
 entry("partners/v1/access","/partners/v1/access","partners","getAccess"),
 entry("guests/v1/guests","/guests/v1/guests","guests","getGuests"),
 entry("customers/v1/customers","/customers/v1/customers","customers","getCustomers"),
 entry("loyalty/v1/accounts","/loyalty/v1/accounts","loyalty","getAccounts"),
 entry("giftcards/v1/giftCards","/giftcards/v1/giftCards","gift-cards","getGiftCards"),
 entry("ordering/v1/orders","/ordering/v1/orders","ordering","getOrders"),
 entry("era/v1/metrics/day","/era/v1/metrics/day","analytics","getDailyMetrics","unsupported"),
 entry("era/v1/reports/{guid}","/era/v1/reports/{guid}","analytics","getReport","id"),
] as const;
const ISO=z.iso.date();
const PAGE_CAP=20;
const PAGE_SIZE=100;
const CHUNK_BYTES=180000;
const RESTRICTED=/(?:password|secret|token|credential|authorization|api.?key|session|cookie|signature|passcode|pin$|ssn|social.?security|routing|account.?number|pan$|cvv|cvc|first.?6|last.?4|last.?four|cardholder|card.?network.?id|card.?number|card.?digits|magstripe|track.?data|expir|email|phone|mobile|fax|birth|first.?name|last.?name|full.?name|chosen.?name|street|address|postal|zip.?code|latitude|longitude|^lat$|^lon$|^lng$|ip.?address|device.?id)/i;
const FREEFORM=/(?:notes?|memo|comment|message|instructions|^text$|description|receiptText|displayName)/i;
const IDENTIFIER=/(?:^customer(?:Id|Guid)$|^guest(?:Id|Guid)$|^loyalty(?:Id|Guid|AccountId)$|^cardPaymentId$|^cardFingerprint$|^cardTokenId$|^paymentCardId$|^cardId$|^customerIdentifier$|^loyaltyIdentifier$)/i;
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
 if(IDENTIFIER.test(key)||(/^(?:id|guid)$/i.test(key)&&/(?:customer|guest|loyalty|card|patron)/i.test(context))){
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
 if(!Array.isArray(raw))return [raw];
 const out:unknown[]=[];let group:unknown[]=[];let bytes=0;
 for(const item of raw){
  const size=JSON.stringify(item).length;
  if(group.length&&bytes+size>CHUNK_BYTES){out.push(group);group=[];bytes=0;}
  group.push(item);bytes+=size;
 }
 if(group.length||!out.length)out.push(group);
 return out;
}
export type ToastRawSampleResult={captured:number;skipped:boolean;failed:number;reason?:"invalid_request"|"no_location"|"busy"|"cooldown"|"db_error"|"missing_hash_key"|"lease_lost";};
const skip=(reason:NonNullable<ToastRawSampleResult["reason"]>,failed=0):ToastRawSampleResult=>({captured:0,skipped:true,failed,reason});
export async function claimToastRawSample(db:Pick<SupabaseClient,"rpc">,businessId:string,restaurantGuid:string,businessDate:string){
 const {data,error}=await db.rpc("toast_claim_raw_sample",{p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_business_date:businessDate});
 if(error)throw new ToastApiError("unavailable");return data===true;
}
function pathFor(s:Entry,day:string,guid:string,id?:string,page=1){
 let path=s.path.replace("{guid}",id??guid);
 const params=new URLSearchParams();
 if(s.scope==="date"){
  params.set(s.endpoint.includes("payments")?"paidBusinessDate":"businessDate",day.replaceAll("-",""));
 }
 if(s.scope==="window"){
  const start=new Date(day+"T00:00:00Z");
  const end=new Date(start.getTime()+86400000);
  params.set("startDate",decodeURIComponent(toToastTimestamp(start)));
  params.set("endDate",decodeURIComponent(toToastTimestamp(end)));
 }
 if(s.page){params.set("pageSize",String(PAGE_SIZE));params.set("page",String(page));}
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
 const hashKey=process.env.TOAST_CUSTOMER_HASH_KEY;
 if(!hashKey||hashKey.length<32)return skip("missing_hash_key");
 let captured=0,failed=0,leaseNonce:string|null=null,reason:ToastRawSampleResult["reason"];
 try{
  const {data:mappings,error}=await db.from("toast_location_mappings").select("restaurant_guid")
   .eq("business_id",businessId).not("verified_at","is",null)
   .order("restaurant_guid",{ascending:true}).limit(1);
  if(error)return skip("db_error",1);
  if(!mappings?.length)return skip("no_location");
  const guid=String(mappings[0].restaurant_guid);
  const acquired=await db.rpc("toast_acquire_lease",{p_business_id:businessId,p_restaurant_guid:guid,p_seconds:290});
  if(acquired.error)return skip("db_error",1);
  if(!acquired.data)return skip("busy");
  leaseNonce=String(acquired.data);
  if(!await claimToastRawSample(db,businessId,guid,businessDate))return skip("cooldown");
  const client=createToastClient(db,businessId);
  const deadlineAt=Date.now()+27*60*1000;
  let lastRenew=Date.now(),lastGet=0;
  const known=new Map<string,Set<string>>();
  const hold=async()=>{
   if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
   if(Date.now()-lastRenew>120000){
    const r=await db.rpc("toast_renew_raw_sample_lease",{p_nonce:leaseNonce,p_seconds:290});
    if(r.error||r.data!==true){reason="lease_lost";throw new Error("lease_lost");}
    lastRenew=Date.now();
   }
  };
  const pace=async()=>{
   await hold();
   const delay=Math.max(0,5000-(Date.now()-lastGet));
   if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
   await hold();lastGet=Date.now();
  };
  const save=async(s:Entry,raw:unknown,status:number|null,page:number|null,
    code:string|null=null,message:string|null=null)=>{
   const safe=redactToastRaw(raw,0,"",hashKey)??{};
   const parts=chunks(safe);
   for(let i=0;i<parts.length;i++){
    await hold();
    const piece=parts[i];
    const {error:err}=await db.from("toast_raw_samples").insert({
     business_id:businessId,restaurant_guid:guid,business_date:businessDate,
     endpoint:s.endpoint,doc_url:s.doc,page_number:page===null?null:page*1000+i,
     http_status:status,item_count:Array.isArray(piece)?piece.length:status===204?0:1,
     sample:piece,field_paths:toastFieldPaths(piece),
     identifier_counts:identifierCounts(raw),error_code:code,error_message:message
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
   if(!ids.length){await save(s,{},null,null,"missing_resource_guid","No identifier discovered in source response");continue;}
   for(const id of ids){
    for(let page=1;page<=(s.page?PAGE_CAP:1);page++){
     try{
      await pace();
      const raw=await client.request(pathFor(s,businessDate,guid,id,page),guid,z.unknown(),{deadlineAt});
      const list=Array.isArray(raw)?raw:raw&&typeof raw==="object"&&Array.isArray((raw as {data?:unknown}).data)?(raw as {data:unknown[]}).data:undefined;
      if(list){const set=known.get(s.endpoint)??new Set<string>();for(const value of list)for(const found of discoveredIds(value))set.add(found);known.set(s.endpoint,set);}
      await save(s,raw,200,s.page?page:1);
      if(!s.page||!list||list.length<PAGE_SIZE)break;
      if(page===PAGE_CAP)await save(s,{},null,page,"page_cap","Pagination capped at 20 pages");
     }catch(e){
      if(reason==="lease_lost")break;
      const status=e instanceof ToastApiError?e.status??null:null;
      const code=e instanceof ToastApiError?e.category:"unavailable";
      await save(s,{},status,s.page?page:1,code,code);
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
