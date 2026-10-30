import {addDays,cafeCountry,daysBetween,holidaysBetween,holidayDateInYear,weekdayOf,type HolidayDay} from "./holidays";
import {typicalDaySales,lastTimeOutlook,typicalHourlySales,type OutlookSalesDay,type LastTimeOutlook,type OutlookHourlyRow,type OutlookHour} from "@/lib/metrics/core/dayOutlook";
import type {NearbyEvent,NearbyEventsSearch} from "./nearbyEvents";
import type {CafeLocation} from "@/lib/data/cafeLocation.server";

/** The ONE "what's coming up" builder. The chat tool (get_nearby_events) and the
 * Home board card both call it, so they see the same calendar and evidence. */

export type OutlookEvent=NearbyEvent&{id:string};
export type OutlookDay={date:string;weekday:string;daysFromToday:number;
  holidays:HolidayDay[];eventIds:string[];
  typicalSalesCents:number|null;typicalSampleDays:number;
  lastTime:(LastTimeOutlook&{holiday:string})|null;
  /** Known same-weekday hourly medians, not predictions. */
  usualHourlySales:OutlookHour[];};
export type EventsOutlook={from:string;to:string;today:string;
  location:{label:string;source:CafeLocation["source"]}|null;country:string|null;countrySource:"profile"|"timezone"|null;
  days:OutlookDay[];localEvents:OutlookEvent[];localEventsSearched:boolean;
  /** Gaps the owner cannot fill by answering a question (search down, no history…). */
  notCovered:string[];addressMissing:boolean};
export type OutlookDeps={today:string;timezone:string;locale:string;from?:string|null;days?:number|null;
  readLocation?:()=>Promise<CafeLocation|null>;
  /** Closed Toast days in [from, to]: null when the read failed, [] when there are none. */
  readSales:(from:string,to:string)=>Promise<OutlookSalesDay[]|null>;
  readHourlySales?:(from:string,to:string)=>Promise<OutlookHourlyRow[]|null>;
  search?:NearbyEventsSearch};

export const MAX_DAYS_AHEAD=60;
const WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] as const;

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
  const [recent,older,found,hourly]=await Promise.all([
    read(recentFrom,recentTo),
    past.length?read(addDays(past[0],-42),past[past.length-1]<recentFrom?past[past.length-1]:addDays(recentFrom,-1)):Promise.resolve([]),
    eventsRead,
    deps.readHourlySales?deps.readHourlySales(recentFrom,recentTo).catch(()=>null):Promise.resolve(null),
  ]);
  if(deps.readHourlySales&&hourly===null)notCovered.push("hourlySalesUnavailable");
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
    days.push({date,weekday:WEEKDAYS[weekdayOf(date)],daysFromToday:daysBetween(today,date),holidays:onDay,
      eventIds:dayEvents.map(e=>e.id),typicalSalesCents:typical.typicalCents,typicalSampleDays:typical.sampleDays,
      lastTime,usualHourlySales:typicalHourlySales(hourly??[],date,today,{weeks:8,exclude})});
  }
  if(history.length&&days.every(d=>d.typicalSalesCents===null))notCovered.push("notEnoughSalesHistory");
  if(!history.length&&recent!==null)notCovered.push("noSalesHistory");
  return {from,to,today,location:location?{label:location.label,source:location.source}:null,
    country:country.country,countrySource:country.source,days,localEvents,localEventsSearched:found!==null,
    notCovered:[...new Set(notCovered)],addressMissing:!location};
}
