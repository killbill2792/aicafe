/**
 * DIAGNOSTIC_ONLY — ONE-TIME, manually authorized, Standard Toast API field probe.
 *
 * No database writes, raw response logs, telemetry or durable output. Uses the
 * existing verified Toast client and its normal credential/rate-limit rules.
 * Owner selects the café by exact database name via workflow_dispatch.
 * Never connect to Analytics, a customer resolver, or an operational reader.
 */
import "server-only";
import {createClient} from "@supabase/supabase-js";
import {z} from "zod";
import {createToastClient,GUID,ToastApiError} from "../lib/pos/toast/client";
import {newFieldReport,observeOrder,observePayment,publicFieldReport}
  from "./toast-standard-customer-probe-core.mjs";

type OrderRow={entity_guid:string|null;restaurant_guid:string;business_date:string;payload:unknown};
type Choice={guid:string;day:string;paymentGuid:string|null;sourceClass:string};
type ReportStatus="ok"|"missing_permissions"|"rate_limited"|"authentication"|
 "not_configured"|"unauthorized_location"|"invalid_response"|"timeout"|"unavailable";
type EndpointName="bulk"|"order_detail"|"payment_detail";
const MAX_ORDERS=20,DB_SCAN_LIMIT=350,MAX_RUN_MS=5*60*1000;
const GUID_RX=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cleanGuid=(v:unknown):string|null=>
 typeof v==="string"&&GUID_RX.test(v)&&GUID.safeParse(v).success?v:null;
const record=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==="object"&&!Array.isArray(v);
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const safeError=(e:unknown):ReportStatus=>{
 if(e instanceof ToastApiError){
  if(["missing_permissions","rate_limited","authentication","not_configured",
      "unauthorized_location","invalid_response","timeout"].includes(e.category))
    return e.category as ReportStatus;
 }
 return "unavailable";
};
function orderChoice(row:OrderRow):Choice|null{
 const o=row.payload;
 if(!record(o))return null;
 const guid=cleanGuid(o.guid);
 if(!guid||!GUID.safeParse(row.restaurant_guid).success||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.business_date))return null;
 const payments=arr(o.checks).flatMap(c=>record(c)?arr(c.payments):[])
  .filter(record);
 const matched=payments.find(p=>cleanGuid(p.guid));
 const paymentGuid=matched?cleanGuid(matched.guid):null;
 const card=payments.find(p=>p.type==="CREDIT");
 const cash=payments.find(p=>p.type==="CASH");
 let sourceClass="other";
 if(o.source==="In Store"){
  if(card&&typeof card.cardEntryMode==="string"&&card.cardEntryMode.startsWith("EMV"))
   sourceClass="in_store_emv";
  else if(card)sourceClass="in_store_other_card";
  else if(cash)sourceClass="in_store_cash";
  else sourceClass="in_store_other";
 }else sourceClass="non_store_control";
 return {guid,day:row.business_date,paymentGuid,sourceClass};
}
function sampleChoices(rows:OrderRow[]):Choice[]{
 const groups=new Map<string,Choice[]>();
 const unique=new Set<string>();
 for(const r of rows){
  const c=orderChoice(r);
  if(!c||unique.has(c.guid))continue;
  unique.add(c.guid);
  groups.set(c.sourceClass,[...(groups.get(c.sourceClass)??[]),c]);
 }
 const quotas:[string,number][]=[
  ["in_store_emv",12],["in_store_other_card",3],
  ["in_store_cash",3],["non_store_control",2]
 ];
 const chosen:Choice[]=[];
 for(const [kind,limit] of quotas)chosen.push(...(groups.get(kind)??[]).slice(0,limit));
 const used=new Set(chosen.map(x=>x.guid));
 for(const r of rows){
  if(chosen.length>=MAX_ORDERS)break;
  const c=orderChoice(r);
  if(c&&!used.has(c.guid)){chosen.push(c);used.add(c.guid);}
 }
 return chosen.slice(0,MAX_ORDERS);
}
const emptyStats=()=>({attempted:0,success:0,failed:0,
 failureCategories:{} as Record<string,number>,unexpectedShape:0});
async function run(){
 const name=process.env.TOAST_PROBE_CAFE_NAME;
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if((name&&name.length>150)||!url||!key||
    !process.env.TOKEN_ENCRYPTION_KEY||!process.env.TOAST_ALLOWED_API_HOSTS)
  throw new Error("probe_not_configured");
 const db=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
 // With no explicit name, fail closed unless there is precisely ONE verified
 // Standard café mapping. This makes the one-off branch runnable even if the
 // GitHub Actions UI reads workflow_dispatch inputs from the default branch.
 let businessId:string,restaurantGuid:string;
 if(name){
  const {data:businesses,error:be}=await db.from("businesses")
   .select("id,name").eq("name",name).limit(2);
  if(be||!businesses||businesses.length!==1)throw new Error("cafe_not_unique_or_available");
  businessId=String(businesses[0].id);
  const {data:mappings,error:me}=await db.from("toast_location_mappings")
   .select("restaurant_guid").eq("business_id",businessId)
   .not("verified_at","is",null).limit(2);
  if(me||!mappings||mappings.length!==1)throw new Error("verified_restaurant_not_unique");
  restaurantGuid=String(mappings[0].restaurant_guid);
 }else{
  const {data:mappings,error:me}=await db.from("toast_location_mappings")
   .select("business_id,restaurant_guid").not("verified_at","is",null).limit(2);
  if(me||!mappings||mappings.length!==1)throw new Error("verified_restaurant_not_unique");
  businessId=String(mappings[0].business_id);
  restaurantGuid=String(mappings[0].restaurant_guid);
 }
 if(!GUID.safeParse(restaurantGuid).success)throw new Error("invalid_location");
 const {data:rows,error:re}=await db.from("toast_raw_records")
  .select("entity_guid,restaurant_guid,business_date,payload")
  .eq("business_id",businessId).eq("restaurant_guid",restaurantGuid)
  .eq("entity","order").is("superseded_by",null)
  .order("business_date",{ascending:false}).limit(DB_SCAN_LIMIT);
 if(re||!rows?.length)throw new Error("no_eligible_source_orders");
 const selected=sampleChoices(rows as OrderRow[]);
 if(selected.length<10)throw new Error("fewer_than_ten_eligible_orders");
 // No raw orders, payment objects, customer identifiers or names enter the report.
 const kinds:EndpointName[]=["bulk","order_detail","payment_detail"];
 const stats=Object.fromEntries(kinds.map(k=>[k,emptyStats()])) as Record<EndpointName,ReturnType<typeof emptyStats>>;
 const summaries=Object.fromEntries(kinds.map(k=>[k,newFieldReport()])) as Record<EndpointName,ReturnType<typeof newFieldReport>>;
 const channelCounts:Record<string,number>={};
 for(const c of selected)channelCounts[c.sourceClass]=(channelCounts[c.sourceClass]??0)+1;
 const client=createToastClient(db,businessId);
 const deadlineAt=Date.now()+MAX_RUN_MS;
 const request=async(kind:EndpointName,path:string,observe:(response:unknown)=>void)=>{
  stats[kind].attempted++;
  try{
   const raw=await client.request(path,restaurantGuid,z.unknown(),{deadlineAt});
   stats[kind].success++;
   if(!record(raw)&&!Array.isArray(raw))stats[kind].unexpectedShape++;
   observe(raw);
  }catch(e){
   stats[kind].failed++;
   const reason=safeError(e);
   stats[kind].failureCategories[reason]=(stats[kind].failureCategories[reason]??0)+1;
  }
 };
 // Compare a small fresh bulk sample against the individually fetched orders.
 const bulkDay=selected[0].day.replaceAll("-","");
 await request("bulk","/orders/v2/ordersBulk?businessDate="+bulkDay+"&pageSize=100&page=1",
  raw=>{
   for(const order of arr(raw).slice(0,20))observeOrder(summaries.bulk,order);
  });
 for(const c of selected){
  if(Date.now()>=deadlineAt)break;
  await request("order_detail","/orders/v2/orders/"+c.guid,
   raw=>observeOrder(summaries.order_detail,raw));
  if(c.paymentGuid&&Date.now()<deadlineAt){
   await request("payment_detail","/orders/v2/payments/"+c.paymentGuid,
    raw=>observePayment(summaries.payment_detail,raw));
  }
 }
 const result={
  diagnostic:"standard_toast_customer_field_probe",
  rawResponsePersisted:false, analyticsUsed:false,
  sampleSize:selected.length, sampleCategoryCounts:channelCounts,
  endpoints:Object.fromEntries(kinds.map(k=>[k,{
   requestCounts:stats[k],fieldCoverage:publicFieldReport(summaries[k]),
  }])),
 };
 return result;
}
try {
 const result=await run();
 process.stdout.write(JSON.stringify({status:"completed",...result})+"\n");
} catch (e) {
 // A single safe error category; never serialize provider/db errors, stacks or raw JSON.
 const permitted=new Set(["probe_not_configured","cafe_not_unique_or_available",
  "verified_restaurant_not_unique","invalid_location","no_eligible_source_orders",
  "fewer_than_ten_eligible_orders"]);
 const message=e instanceof Error&&permitted.has(e.message)?e.message:"probe_unavailable";
 process.stdout.write(JSON.stringify({status:"failed",reason:message})+"\n");
 process.exitCode=1;
}
