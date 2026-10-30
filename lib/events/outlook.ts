import {addDays,cafeCountry,daysBetween,holidaysBetween,holidayDateInYear,weekdayOf,type HolidayDay} from "./holidays";
import {typicalDaySales,lastTimeOutlook,type OutlookSalesDay,type LastTimeOutlook} from "@/lib/metrics/core/dayOutlook";
import type {NearbyEvent,NearbyEventsSearch} from "./nearbyEvents";
import type {CafeLocation} from "@/lib/data/cafeLocation.server";

/** The ONE "what's coming up" builder. The chat tool (get_nearby_events) and the
 * Home board card both call it, so they always show the same days and decisions. */

export type DayExpect="busier"|"quieter"|"normal"|"unsure";
export type DayAction="add_staff"|"keep_staff_light"|"normal_staff"|"have_backup";
export type DayBasis="your_sales"|"nearby_event"|"general_pattern"|"none";
export type DayDecision={expect:DayExpect;action:DayAction;basis:DayBasis};
export type OutlookEvent=NearbyEvent&{id:string};
export type OutlookDay={date:string;weekday:string;daysFromToday:number;
  holidays:Array<Pick<HolidayDay,"key"|"name"|"kind"|"dayOff"|"usualEffect"|"why">>;eventIds:string[];
  typicalSalesCents:number|null;typicalSampleDays:number;
  lastTime:(LastTimeOutlook&{holiday:string})|null;
  /** Worth showing the owner: a holiday, a local event, or a clear sales signal. */
  notable:boolean;decision:DayDecision};
export type EventsOutlook={from:string;to:string;today:string;
  location:{label:string;source:CafeLocation["source"]}|null;country:string|null;countrySource:"profile"|"timezone"|null;
  days:OutlookDay[];localEvents:OutlookEvent[];localEventsSearched:boolean;
  /** Gaps the owner cannot fill by answering a question (search down, no history…). */
  notCovered:string[];addressMissing:boolean};
export type OutlookDeps={today:string;timezone:string;locale:string;from?:string|null;days?:number|null;
  readLocation?:()=>Promise<CafeLocation|null>;
  /** Closed Toast days in [from, to]: null when the read failed, [] when there are none. */
  readSales:(from:string,to:string)=>Promise<OutlookSalesDay[]|null>;
  search?:NearbyEventsSearch};

export const MAX_DAYS_AHEAD=60;
/** A change this size (whole percent) against a usual day counts as busier/quieter. */
export const NOTABLE_CHANGE_PERCENT=10;
const WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] as const;

/** Plain decision for one day. Priority: the café's own past sales, then a big
 * event nearby, then the general pattern for that holiday. */
export function decideDay(day:Pick<OutlookDay,"lastTime"|"holidays">,events:readonly NearbyEvent[]):DayDecision{
  const change=day.lastTime?.changePercent;
  if(typeof change==="number"){
    if(change>=NOTABLE_CHANGE_PERCENT)return {expect:"busier",action:"add_staff",basis:"your_sales"};
    if(change<=-NOTABLE_CHANGE_PERCENT)return {expect:"quieter",action:"keep_staff_light",basis:"your_sales"};
    return {expect:"normal",action:"normal_staff",basis:"your_sales"};
  }
  if(events.some(e=>e.expectedCrowd==="large"||e.expectedCrowd==="medium")&&!events.every(e=>e.kind==="road_closure"))
    return {expect:"busier",action:"add_staff",basis:"nearby_event"};
  if(events.length)return {expect:"unsure",action:"have_backup",basis:"nearby_event"};
  const effects=day.holidays.filter(h=>h.why!==null).map(h=>h.usualEffect);
  if(effects.includes("busier"))return {expect:"busier",action:"add_staff",basis:"general_pattern"};
  if(effects.includes("quieter"))return {expect:"quieter",action:"keep_staff_light",basis:"general_pattern"};
  if(effects.length)return {expect:"unsure",action:"have_backup",basis:"general_pattern"};
  return {expect:"normal",action:"normal_staff",basis:"none"};
}

export async function buildEventsOutlook(deps:OutlookDeps):Promise<EventsOutlook|{tooFarAhead:true;maxDaysAhead:number}>{
  const today=deps.today,notCovered:string[]=[];
  let from=deps.from??today;
  if(from<today){from=today;notCovered.push("pastDatesNotCovered");}
  if(daysBetween(today,from)>MAX_DAYS_AHEAD)return {tooFarAhead:true,maxDaysAhead:MAX_DAYS_AHEAD};
  const to=addDays(from,Math.min(Math.max(deps.days??7,1),10)-1);

  let location:CafeLocation|null=null;
  if(deps.readLocation){
    try{location=await deps.readLocation();}catch{notCovered.push("locationReadFailed");}
  }
  const country=cafeCountry(location?.countryCode,deps.timezone);
  const region=location?.source==="profile"?location.region:null;
  const safeHolidays=(a:string,b:string,lang=deps.locale)=>{
    try{return holidaysBetween(a,b,country.country,region,lang);}
    catch{return holidaysBetween(a,b,country.country,null,lang);}
  };
  const holidays=safeHolidays(from,to);
  if(!country.country)notCovered.push(location?"holidaysNeedCountry":"holidaysNeedAddress");

  const eventsRead:Promise<NearbyEvent[]|null>=!location?Promise.resolve(null):
    !deps.search?Promise.resolve(null).then(()=>{notCovered.push("localEventsSearchUnavailable");return null;}):
    deps.search({location:location.label,city:location.city,region:location.region,
      countryCode:location.countryCode??country.country,from,to})
      .then(r=>{if(r.available)return r.events;
        notCovered.push(r.reason==="notConfigured"?"localEventsSearchUnavailable":"localEventsSearchFailed");return null;})
      .catch(()=>{notCovered.push("localEventsSearchFailed");return null;});

  // The same holiday last year, from the library (dates can move between years).
  const lastYear=new Map<string,string>();
  for(const h of holidays){
    let d:string|null=null;
    try{d=holidayDateInYear(h.key,Number(h.date.slice(0,4))-1,country.country,region);}catch{d=null;}
    if(d)lastYear.set(h.key+"|"+h.date,d);
  }
  const past=[...lastYear.values()].sort();
  const recentFrom=addDays(today,-56),recentTo=addDays(today,-1);
  const read=(a:string,b:string)=>a>b?Promise.resolve([] as OutlookSalesDay[]):deps.readSales(a,b).catch(()=>null);
  const [recent,older,found]=await Promise.all([
    read(recentFrom,recentTo),
    past.length?read(addDays(past[0],-42),past[past.length-1]<recentFrom?past[past.length-1]:addDays(recentFrom,-1)):Promise.resolve([]),
    eventsRead,
  ]);
  if(recent===null||older===null)notCovered.push("salesHistoryUnavailable");
  const byDate=new Map<string,OutlookSalesDay>();
  for(const d of [...(older??[]),...(recent??[])])byDate.set(d.date,d);
  const history=[...byDate.values()];
  const historyStart=history.reduce((m,d)=>d.date<m?d.date:m,today);
  // Holidays are not "usual" days: keep them out of the usual-day base.
  const exclude=new Set(safeHolidays(historyStart,recentTo,"en").map(h=>h.date));

  const localEvents=(found??[]).map((e,i)=>({id:"e"+(i+1),...e}));
  const days:OutlookDay[]=[];
  for(let date=from;date<=to;date=addDays(date,1)){
    const onDay=holidays.filter(h=>h.date===date);
    const dayEvents=localEvents.filter(e=>e.startDate<=date&&e.endDate>=date);
    const typical=typicalDaySales(history,date,today,{weeks:8,exclude});
    let lastTime:OutlookDay["lastTime"]=null;
    for(const h of onDay){
      const d=lastYear.get(h.key+"|"+h.date);
      const hit=d?lastTimeOutlook(history,d,exclude):null;
      if(hit){lastTime={...hit,holiday:h.name};break;}
    }
    const shown=onDay.map(({key,name,kind,dayOff,usualEffect,why})=>({key,name,kind,dayOff,usualEffect,why}));
    const decision=decideDay({lastTime,holidays:shown},dayEvents);
    const notable=dayEvents.length>0||onDay.some(h=>h.dayOff||h.why!==null)||
      (decision.basis==="your_sales"&&decision.expect!=="normal");
    days.push({date,weekday:WEEKDAYS[weekdayOf(date)],daysFromToday:daysBetween(today,date),holidays:shown,
      eventIds:dayEvents.map(e=>e.id),typicalSalesCents:typical.typicalCents,typicalSampleDays:typical.sampleDays,
      lastTime,notable,decision});
  }
  if(history.length&&days.every(d=>d.typicalSalesCents===null))notCovered.push("notEnoughSalesHistory");
  if(!history.length&&recent!==null)notCovered.push("noSalesHistory");
  return {from,to,today,location:location?{label:location.label,source:location.source}:null,
    country:country.country,countrySource:country.source,days,localEvents,localEventsSearched:found!==null,
    notCovered:[...new Set(notCovered)],addressMissing:!location};
}
