import en from "@/messages/en.json";
import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import {addCalendarDays} from "@/lib/pos/toast/scheduleDates";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import type {OwnerProposalRow} from "@/lib/ai/supervisor/loop/reads.server";

/** Template body order is owned by the approved Meta template, not by a model. */
export type DailyBriefParameters=readonly [string,string,string,string,string,string,string];
export type MorningBriefEvidence={
  businessId:string;businessName:string;currency:string|null;
  today:string;yesterday:string;netSalesCents:number|null;salesStatus:string|null;
  itemCoverage:boolean;
  soldItems:readonly {id:string;units:number}[];
  menu:readonly {id:string;name:string;base_name:string|null;category:string}[];
  savedEvents:readonly CafeEvent[];
  monitors:readonly OwnerProposalRow[];
  /** Verified binding/consent and permission to deliver a later alert are checked by PR A. */
  verifiedBinding:boolean;followupPermitted:boolean;
};
export type PreparedMorningBrief={
  netSalesCents:number;
  parameters:DailyBriefParameters;
  businessDate:string;today:string;
  provenance:{sales:"daily_rollups";items:"menu_item_quantities_sold";menu:"menu_items";
    eventId:string;monitorProposalId:string};
};

const drinkCategories=new Set(["ESPRESSO_DRINK","BREWED_COFFEE","COLD_BREW","TEA","SPECIALTY_DRINK","drink"]);
const otherCategories=new Set(["PASTRY","FOOD","RETAIL","food"]);
function safeText(value:string,max=160):string|null{
  // Meta body variables must not introduce line breaks, markup or control characters.
  const s=Array.from(value,ch=>{
    const code=ch.codePointAt(0)??0;
    return code<32||code===127?" ":ch;
  }).join("").replace(/[\\*_~`<>]/g,"").replace(/\s+/g," ").trim();
  return s.length>0&&s.length<=max?s:null;
}
function isDay(day:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  const d=new Date(day+"T12:00:00Z");
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===day;
}
function activeSameWeekdayMonitor(monitors:readonly OwnerProposalRow[],today:string):string|null{
  for(const m of monitors){
    if(!["committed","manual_confirmed"].includes(m.status)||!m.monitoring_start_date)continue;
    const spec=m.monitor_spec as {metricScope?:unknown;durationDays?:unknown}|null;
    // An event/price experiment is NOT automatically a weekday-sales alert.
    if(spec?.metricScope!=="same_weekday_sales"||typeof spec.durationDays!=="number"||
      !Number.isInteger(spec.durationDays)||spec.durationDays<1||spec.durationDays>365)continue;
    const start=m.monitoring_start_date;
    if(!isDay(start))continue;
    const end=addCalendarDays(start,spec.durationDays-1);
    if(start<=today&&today<=end)return m.id;
  }
  return null;
}
function verifiedEvent(events:readonly CafeEvent[],today:string,now:Date):{id:string;text:string}|null{
  const eligible=events.filter(e=>{
    if(e.status!=="found"||e.startDate>today||e.endDate<today||
      !e.lastVerifiedAt||!Number.isFinite(Date.parse(e.lastVerifiedAt)))return false;
    const verifiedAt=Date.parse(e.lastVerifiedAt);
    // Do not use stale or superseded verification as a claim about today's event.
    if(verifiedAt>now.getTime()||now.getTime()-verifiedAt>72*60*60*1000)return false;
    if(e.verificationFailedAt&&Date.parse(e.verificationFailedAt)>verifiedAt)return false;
    if(e.kind!=="holiday"&&(!e.sourceUrl||!/^https:\/\//i.test(e.sourceUrl)))return false;
    return true;
  }).sort((a,b)=>(a.startTime??"99:99").localeCompare(b.startTime??"99:99")||
    a.id.localeCompare(b.id));
  for(const e of eligible){
    const name=safeText(e.name,90);
    const venue=e.venue?safeText(e.venue,65):null;
    const time=e.startTime&&/^([01]\d|2[0-3]):[0-5]\d/.test(e.startTime)?
      e.startTime.slice(0,5):null;
    if(!name)continue;
    const text=safeText([name,venue?"at "+venue:null,time?"at "+time:null]
      .filter(Boolean).join(" "),240);
    if(text)return {id:e.id,text};
  }
  return null;
}

/** Fail closed until the exact seven facts AND active weekday-alert promise are proved.
 * No provider calls, new search, finance calculation, or notification state lives here. */
export function prepareMorningBrief(e:MorningBriefEvidence,now:Date):PreparedMorningBrief|null{
  if(!e.verifiedBinding||!e.followupPermitted||!isDay(e.today)||!isDay(e.yesterday)||
    addCalendarDays(e.yesterday,1)!==e.today||e.salesStatus!=="actual"||
    !Number.isSafeInteger(e.netSalesCents)||e.netSalesCents===null||
    !e.itemCoverage||!e.soldItems.length)return null;
  const businessName=safeText(e.businessName,120);
  const money=formatCafeCurrency(e.netSalesCents,"en",e.currency);
  if(!businessName||money.currencyMissing)return null;
  const monitorId=activeSameWeekdayMonitor(e.monitors,e.today);
  const event=verifiedEvent(e.savedEvents,e.today,now);
  if(!monitorId||!event)return null;

  const menu=new Map(e.menu.map(item=>[item.id,item]));
  const drinks=new Map<string,number>();
  let total=0;
  for(const sold of e.soldItems){
    const item=menu.get(sold.id);
    if(!item||!Number.isSafeInteger(sold.units)||sold.units<0||
      (!drinkCategories.has(item.category)&&!otherCategories.has(item.category)))return null;
    if(!drinkCategories.has(item.category))continue;
    const name=safeText(item.base_name?.trim()||item.name,120);
    if(!name)return null;
    const next=(drinks.get(name)??0)+sold.units;
    total+=sold.units;
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(next))return null;
    drinks.set(name,next);
  }
  if(!total||!drinks.size)return null;
  const best=[...drinks].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
  const weekday=new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:"UTC"})
    .format(new Date(e.today+"T12:00:00Z"));
  const parameters=[businessName,money.text,String(total),best[0],String(best[1]),
    event.text,weekday] as const;
  if(parameters.some(v=>!safeText(v,240)))return null;
  return {netSalesCents:e.netSalesCents,parameters,businessDate:e.yesterday,today:e.today,
    provenance:{sales:"daily_rollups",items:"menu_item_quantities_sold",menu:"menu_items",
      eventId:event.id,monitorProposalId:monitorId}};
}

/** The approved Meta template text is also the website's canonical owner-facing brief.
 * Never reconstruct the same fact in a second, independently worded notification. */
export function renderMorningBrief(parameters:DailyBriefParameters):string{
  // Single pass: "$&", "$$" and embedded "{{2}}" are literal café data.
  return en.DailyBrief.whatsappTemplate.replace(/\{\{([1-7])\}\}/g,
    (_match,index:string)=>parameters[Number(index)-1]);
}
