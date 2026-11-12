import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {formatInTimeZone} from "date-fns-tz";
import {readDailyFactRows} from "@/lib/data/dailyFacts.server";
import {utcDateOffset} from "./engine";
export type ElapsedWindow={index:number;startAt:string;endAt:string};
export type SourceLine={id:string;orderedAt:string|null;closedAt:string|null;
 quantity:number;netSalesCents:number;voided:boolean;
 toastExcluded:boolean;supersededBy:string|null};
export type WindowEvidence={window:ElapsedWindow;status:"actual"|"insufficient_evidence";
 units:number|null;revenueCents:number|null;countedLines:number;
 unknownTimeLines:number;source:"order_lines.ordered_at";asOf:string};
const DAY_MS=86400000;
function instant(value:string):number{
 const n=Date.parse(value);
 if(!Number.isFinite(n)||!/(Z|[+-]\\d{2}:?\\d{2})$/.test(value))
  throw new Error("invalid_source_instant");
 return n;
}
/** Exactly N elapsed UTC 24-hour periods, never café calendar days or
 * the number of midnight crossings (DST can produce 23h/25h days). */
export function planElapsed24HourWindows(startAt:string,days:number):ElapsedWindow[]{
 const start=instant(startAt);
 if(!Number.isSafeInteger(days)||days<1||days>90)throw new Error("invalid_monitor_duration");
 return Array.from({length:days},(_,index)=>({
  index,startAt:new Date(start+index*DAY_MS).toISOString(),
  endAt:new Date(start+(index+1)*DAY_MS).toISOString(),
 }));
}
/** A candidate is an actual order LINE, not a daily summary. Unknown line
 * times and closure evidence invalidate completeness, not observed revenue. */
export function summarizeElapsedWindow(window:ElapsedWindow,lines:readonly SourceLine[],
 sourceCoverageVerified:boolean,asOf:string):WindowEvidence{
 const start=instant(window.startAt),end=instant(window.endAt);
 const observed=instant(asOf);
 if(end<=start||end-start!==DAY_MS)throw new Error("not_elapsed_24_hours");
 let units=0,revenue=0,countedLines=0,unknownTimeLines=0;
 const seen=new Set<string>();
 for(const line of lines){
  if(seen.has(line.id))continue;seen.add(line.id);
  if(line.voided||line.toastExcluded||line.supersededBy!==null)continue;
  if(!line.orderedAt||!line.closedAt){unknownTimeLines++;continue;}
  let orderTime:number,closeTime:number;
  try{orderTime=instant(line.orderedAt);closeTime=instant(line.closedAt);}
  catch{unknownTimeLines++;continue;}
  if(closeTime<orderTime||closeTime>observed){unknownTimeLines++;continue;}
  if(orderTime<start||orderTime>=end)continue;
  if(!Number.isFinite(line.quantity)||line.quantity<0||
     !Number.isSafeInteger(line.netSalesCents)){unknownTimeLines++;continue;}
  units+=line.quantity;revenue+=line.netSalesCents;countedLines++;
 }
 const complete=sourceCoverageVerified&&unknownTimeLines===0&&observed>=end&&
  Number.isSafeInteger(revenue)&&Number.isFinite(units);
 return {window,status:complete?"actual":"insufficient_evidence",
  units:complete?units:null,revenueCents:complete?revenue:null,
  countedLines,unknownTimeLines,source:"order_lines.ordered_at",asOf};
}
/** Only an actually observed closing instant can define extra final-window
 * trading. A configured closeout hour is never a verified actual close. */
export function planVerifiedFinalCloseInterval(window:ElapsedWindow,
 actualClosedAt:string|null):{startAt:string;endAt:string}|null{
 if(!actualClosedAt)return null;
 const end=instant(window.endAt),actual=instant(actualClosedAt);
 return actual>end?{startAt:window.endAt,endAt:new Date(actual).toISOString()}:null;
}
/** The existing canonical importer attests only coverage, never supplies window
 * amounts. An incomplete café-local day makes the entire elapsed period
 * unproven, even if a few source-timed line items happen to be present. */
export async function verifiedWindowSourceCoverage(db:SupabaseClient,
 businessId:string,timezone:string,window:ElapsedWindow):Promise<boolean>{
 const start=new Date(instant(window.startAt));
 const end=new Date(instant(window.endAt)-1);
 const first=formatInTimeZone(start,timezone,"yyyy-MM-dd");
 const last=formatInTimeZone(end,timezone,"yyyy-MM-dd");
 const facts=await readDailyFactRows(db,businessId,first,last);
 const status=new Map(facts.map(f=>[f.business_date,f.sales_data_status]));
 for(let day=first;day<=last;day=utcDateOffset(day,1)){
  if(status.get(day)!=="actual")return false;
 }
 return true;
}
/** Pull bounded source LINE records and explicitly query for lines missing
 * event times. No daily rollup or café calendar-day value is substituted.
 * This read never marks source coverage complete on its own. */
export async function readElapsedWindowObservations(db:SupabaseClient,
 businessId:string,menuItemId:string,window:ElapsedWindow,asOf:string,
 timezone:string):Promise<WindowEvidence>{
 const base=()=>db.from("order_lines")
  .select("id,ordered_at,quantity,net_sales_cents,voided,orders!inner(closed_at,business_id,toast_excluded,superseded_by)",{count:"exact"})
  .eq("menu_item_id",menuItemId).eq("orders.business_id",businessId)
  .eq("orders.toast_excluded",false).is("orders.superseded_by",null)
  .eq("voided",false);
 const [known,missing,sourceCovered]=await Promise.all([
  base().gte("ordered_at",window.startAt).lt("ordered_at",window.endAt)
   .limit(10000),
  // A line with an unknown order time may close AFTER this window. Its
  // missing source timestamp cannot be silently excluded from earlier sales.
  base().is("ordered_at",null).gte("orders.closed_at",window.startAt)
   .lte("orders.closed_at",asOf).limit(10000),
  verifiedWindowSourceCoverage(db,businessId,timezone,window),
 ]);
 if(known.error||missing.error)throw new Error("rolling_sales_source_read_failed");
 const completePages=[known,missing].every(r=>r.count!==null&&
  r.count===(r.data?.length??0));
 const rows=[...(known.data??[]),...(missing.data??[])].map(row=>{
  const order=Array.isArray(row.orders)?row.orders[0]:row.orders;
  return {id:row.id,orderedAt:row.ordered_at,closedAt:order?.closed_at??null,
   quantity:Number(row.quantity),netSalesCents:Number(row.net_sales_cents),
   voided:row.voided,toastExcluded:Boolean(order?.toast_excluded),
   supersededBy:order?.superseded_by??null};
 });
 const measured=summarizeElapsedWindow(window,rows,sourceCovered&&completePages,asOf);
 return completePages?measured:{...measured,
  unknownTimeLines:measured.unknownTimeLines+1};
}
