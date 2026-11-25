import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {GUID,ToastApiError,createToastClient} from "./client";
import {parseToastDayPage} from "./dayParser";
import {currentToastBusinessDay} from "./todaySoFar";
import {localClock,addCalendarDays} from "./scheduleDates";
import {liveArchivePage,isFinishedToastOrder} from "./liveArchive";
import {redactToastRaw} from "./redact";
import {stableToastOrder} from "./stableOrder";

export type OrderScope={businessId:string;restaurantGuid:string;timezone:string;closeoutHour:number};
const rawSchema=z.object({guid:GUID,modifiedDate:z.string().min(1),
 businessDate:z.number().int().nullish(),openedDate:z.string().nullish()}).passthrough();
const epoch=(value:string)=>Date.parse(value.replace(/([+-]\d{2})(\d{2})$/,"$1:$2"));
export function sourceOrderDay(raw:unknown,scope:OrderScope):string{
 const o=rawSchema.safeParse(raw);
 if(!o.success||!Number.isFinite(epoch(o.data.modifiedDate)))throw new ToastApiError("invalid_response");
 if(o.data.businessDate!=null){
  const d=String(o.data.businessDate);
  const day=d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6);
  if(!/^20\d{6}$/.test(d)||!z.iso.date().safeParse(day).success)throw new ToastApiError("invalid_response");
  return day;
 }
 if(!o.data.openedDate||!Number.isFinite(epoch(o.data.openedDate)))throw new ToastApiError("invalid_response");
 const c=localClock(new Date(epoch(o.data.openedDate)),scope.timezone);
 return c.minutes<scope.closeoutHour*60?addCalendarDays(c.today,-1):c.today;
}
function stableKeys(value:unknown):unknown{
 if(Array.isArray(value))return value.map(stableKeys);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableKeys(v)]));
 return value;
}
export function sameOrOlderOrder(previous:unknown,incoming:unknown):boolean{
 const old=rawSchema.safeParse(previous),next=rawSchema.safeParse(incoming);
 if(!old.success||!next.success||old.data.guid.toLowerCase()!==next.data.guid.toLowerCase())return false;
 const a=epoch(old.data.modifiedDate),b=epoch(next.data.modifiedDate);
 if(Number.isFinite(a)&&Number.isFinite(b)&&a>b)return true;
 return JSON.stringify(stableKeys(stableToastOrder(previous)))===JSON.stringify(stableKeys(stableToastOrder(incoming)));
}

/** The existing archive is the only writer for provisional orders. Until the
 * closed-day importer supports per-object commits, a genuinely changed closed
 * day uses its existing durable targeted repair, never an unconditional backfill.
 * The event is acknowledged only after its archive write or repair enqueue.
 * Open current orders still use the existing Today Live path pending parity. */
export async function ingestToastOrderRevision(db:SupabaseClient,scope:OrderScope,raw:unknown,now=new Date()){
 const row=rawSchema.parse(raw);
 const day=sourceOrderDay(raw,scope);
 const current=currentToastBusinessDay(now,scope.timezone,scope.closeoutHour);
 if(day>current)throw new ToastApiError("invalid_response");
 const proof=parseToastDayPage([raw],scope.restaurantGuid,day,scope.timezone,scope.closeoutHour);
 if(proof.unparsed.length||proof.orders.length!==1)throw new ToastApiError("invalid_response");
 const {data:status,error:statusError}=await db.from("toast_day_status").select("import_state,last_import_run_id,coverage_complete")
  .eq("business_id",scope.businessId).eq("restaurant_guid",scope.restaurantGuid).eq("business_date",day).maybeSingle();
 if(statusError)throw new ToastApiError("unavailable");
 if(day===current&&status?.import_state!=="imported"){
  if(!isFinishedToastOrder(raw))return "open" as const;
  const payload=liveArchivePage([raw]);
  if(payload.length!==1)throw new ToastApiError("invalid_response");
  const {data,error}=await db.rpc("toast_archive_live_orders",{p_business_id:scope.businessId,
   p_restaurant_guid:scope.restaurantGuid,p_business_date:day,p_payload:payload});
  if(error||typeof data!=="number")throw new ToastApiError("unavailable");
  return data>0?"archived" as const:"unchanged" as const;
 }
 if(day>=localClock(now,scope.timezone).today)throw new ToastApiError("invalid_response");
 const incoming=stableToastOrder(redactToastRaw(raw,0,"",undefined,"orders"));
 const {data:prior,error:priorError}=await db.from("toast_raw_records").select("payload,run_id,seen_run_id")
  .eq("business_id",scope.businessId).eq("restaurant_guid",scope.restaurantGuid).eq("entity","order")
  .eq("entity_guid",row.guid).eq("business_date",day).maybeSingle();
 if(priorError)throw new ToastApiError("unavailable");
 const run=status?.last_import_run_id;
 if(status?.import_state==="imported"&&status.coverage_complete===true&&run&&prior&&
    (prior.run_id===run||prior.seen_run_id===run)&&sameOrOlderOrder(prior.payload,incoming))return "unchanged" as const;
 const {error}=await db.rpc("toast_queue_owner_repull",{p_business_id:scope.businessId,
  p_restaurant_guid:scope.restaurantGuid,p_date:day});
 if(error)throw new ToastApiError("unavailable");
 return "repair_queued" as const;
}

export async function fetchAndIngestToastOrder(db:SupabaseClient,scope:OrderScope,orderGuid:string,deadlineAt?:number){
 if(!GUID.safeParse(orderGuid).success)throw new ToastApiError("invalid_response");
 // Webhook payload omits permitted source fields; fetch the one affected order
 // rather than overwriting the existing full API object with a partial message.
 const raw=await createToastClient(db,scope.businessId).request("/orders/v2/orders/"+orderGuid,
  scope.restaurantGuid,rawSchema,{deadlineAt});
 if(raw.guid.toLowerCase()!==orderGuid.toLowerCase())throw new ToastApiError("invalid_response");
 return ingestToastOrderRevision(db,scope,raw);
}
