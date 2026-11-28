import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {GUID,ToastApiError,createToastClient} from "./client";
import {parseToastDayPage} from "./dayParser";
import {localClock,addCalendarDays} from "./scheduleDates";
import {redactToastRaw} from "./redact";
import {stableToastOrder} from "./stableOrder";

export type OrderScope={businessId:string;restaurantGuid:string;timezone:string;closeoutHour:number};
const rawSchema=z.object({guid:GUID,modifiedDate:z.string().min(1),
 businessDate:z.number().int().nullish(),openedDate:z.string().nullish()}).passthrough();
const epoch=(value:string)=>Date.parse(value.replace(/([+-]\d{2})(\d{2})$/,(_,hours:string,minutes:string)=>hours+":"+minutes));
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
 return JSON.stringify(stableKeys(previous))===JSON.stringify(stableKeys(incoming));
}

/** Preserve source evidence even when a normalized parser cannot understand
 * a check. The shared live reader reports parse gaps, never false zero totals. */
export function prepareToastOrderRevision(scope:OrderScope,raw:unknown){
 const day=sourceOrderDay(raw,scope);
 const payload=redactToastRaw(raw,0,"",undefined,"orders");
 if(!rawSchema.safeParse(payload).success)throw new ToastApiError("invalid_response");
 const parsed=parseToastDayPage([stableToastOrder(payload)],scope.restaurantGuid,day,scope.timezone,scope.closeoutHour);
 // Keep only the parse outcome from the existing validator. PostgreSQL derives
 // provisional financial values from the retained JSON.
 return parsed.unparsed.length ? {day,payload,parseFailed:true as const} : {day,payload};
}
export async function ingestToastOrderRevision(db:SupabaseClient,scope:OrderScope,raw:unknown){
 const {data,error}=await db.rpc("toast_ingest_order_revisions",{
  p_business_id:scope.businessId,p_restaurant_guid:scope.restaurantGuid,p_rows:[prepareToastOrderRevision(scope,raw)]});
 if(error||typeof data!=="number")throw new ToastApiError("unavailable");
 return data>0?"archived" as const:"unchanged" as const;
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
