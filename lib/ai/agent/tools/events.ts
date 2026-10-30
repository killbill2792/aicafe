import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {addDays,cafeCountry,holidaysBetween,holidayDateInYear,weekdayOf,BUILT_IN_HOLIDAY_COUNTRIES,type HolidayDay} from "@/lib/calc/holidays";
import {typicalDaySales,lastTimeOutlook,type OutlookSalesDay,type LastTimeOutlook} from "@/lib/metrics/core/dayOutlook";
import type {NearbyEvent} from "@/lib/ai/events/nearbyEvents";
import {CAFE_ADDRESS_FACT} from "@/lib/data/cafeLocation.server";

export const nearbyEventsInput=z.strictObject({
  start_date:z.iso.date().nullable(),
  days:z.number().int().min(1).max(10).nullable(),
});
const WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"] as const;
const MAX_DAYS_AHEAD=60;

function daysBetween(from:string,to:string):number{
  return Math.round((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86_400_000);
}
async function salesDays(ctx:AgentToolContext,from:string,to:string):Promise<OutlookSalesDay[]|null>{
  if(from>to)return [];
  try{
    const slice=await ctx.tools.getSalesTrend({from,to});
    if(!slice.available)return [];
    return slice.value.map(d=>({date:d.date,netSalesCents:d.netSalesCents}));
  }catch{return null;}
}

/** "What's happening near my café?" — holidays (code), local events (web search
 * near the café's saved address) and what similar days brought in Toast sales.
 * Read-only: it never changes a schedule; staffing changes stay propose_* cards. */
export const eventsTools={
  get_nearby_events:{
    agentId:"alex",schema:nearbyEventsInput,
    description:"Holidays, observances (e.g. Halloween, Labor Day) and local events near the café (festivals, conferences, games, parades, road closures) for the next days, with what similar days brought in the café's own Toast sales. "+
      "Use for: events nearby, anything happening this week/weekend, holidays, will it be busy, how many staff should I have, should I prepare more. start_date null = today; days null = 7 (max 10). "+
      "If missing has cafe_address, the café address is unknown: still give the holiday part, then call ask_owner kind=facts with one text field key cafe_address asking for the café's street address, city and ZIP/postal code. "+
      "Answer like a manager: lead with the 1–2 days that matter most (today/tomorrow first), say what is happening, whether to expect more or fewer customers, and one concrete action (staff, stock, hours or a promo). "+
      "Base the expectation on lastTime.changePercent when present (your own Toast sales on that day last time) and typicalSalesCents (a usual day like it); otherwise use usualEffect and why, and say it is a general pattern, not their data. "+
      "Never invent crowd sizes, dates or events; name the source site for local events. For staffing advice also call get_week_schedule for those days. Do not list days with nothing on them.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=nearbyEventsInput.parse(raw);
      const today=ctx.asOf,notCovered:string[]=[];
      let from=input.start_date??today;
      if(from<today){from=today;notCovered.push("pastDatesNotCovered");}
      if(daysBetween(today,from)>MAX_DAYS_AHEAD)
        return {source:"nearby_events",period:null,agentId:"alex",missing:[],notCovered:["tooFarAhead"],maxDaysAhead:MAX_DAYS_AHEAD};
      const to=addDays(from,(input.days??7)-1),period={from,to};

      let location:Awaited<ReturnType<NonNullable<AgentToolContext["cafeLocation"]>>>=null;
      if(ctx.cafeLocation){
        try{location=await ctx.cafeLocation();}catch{notCovered.push("locationReadFailed");}
      }
      const country=cafeCountry(location?.countryCode,ctx.timezone);
      const holidays=holidaysBetween(from,to,country.country);
      if(!(BUILT_IN_HOLIDAY_COUNTRIES as readonly string[]).includes(country.country??""))
        notCovered.push(location?"holidaysFromWebSearchOnly":"holidaysNeedCountry");

      // Local events: web search near the café, in parallel with the sales reads.
      const eventsRead:Promise<NearbyEvent[]|null>=!location?Promise.resolve(null):
        !ctx.searchNearbyEvents?Promise.resolve(null).then(()=>{notCovered.push("localEventsSearchUnavailable");return null;}):
        ctx.searchNearbyEvents({location:location.label,city:location.city,region:location.region,
          countryCode:location.countryCode??country.country,from,to})
          .then(r=>{if(r.available)return r.events;
            notCovered.push(r.reason==="notConfigured"?"localEventsSearchUnavailable":"localEventsSearchFailed");return null;})
          .catch(()=>{notCovered.push("localEventsSearchFailed");return null;});

      // Same holiday last year, to compare with this café's own sales.
      const lastYear=new Map<string,string>();
      for(const h of holidays){
        const d=holidayDateInYear(h.key,Number(h.date.slice(0,4))-1);
        if(d)lastYear.set(h.key+"|"+h.date,d);
      }
      const past=[...lastYear.values()].sort();
      const recentFrom=addDays(today,-56),recentTo=addDays(today,-1);
      const [recent,older,localEvents]=await Promise.all([
        salesDays(ctx,recentFrom,recentTo),
        past.length?salesDays(ctx,addDays(past[0],-42),past[past.length-1]<recentFrom?past[past.length-1]:addDays(recentFrom,-1)):Promise.resolve([]),
        eventsRead,
      ]);
      if(recent===null||older===null)notCovered.push("salesHistoryUnavailable");
      const byDate=new Map<string,OutlookSalesDay>();
      for(const d of [...(older??[]),...(recent??[])])byDate.set(d.date,d);
      const history=[...byDate.values()];
      // Holidays are not "usual" days: keep them out of the usual-day base.
      const historyStart=history.length?history.reduce((m,d)=>d.date<m?d.date:m,history[0].date):today;
      const exclude=new Set(holidaysBetween(historyStart,recentTo,country.country).map(h=>h.date));

      const events=(localEvents??[]).map((e,i)=>({id:"e"+(i+1),...e}));
      const days=[];
      for(let date=from;date<=to;date=addDays(date,1)){
        const onDay=holidays.filter(h=>h.date===date);
        const eventIds=events.filter(e=>e.startDate<=date&&e.endDate>=date).map(e=>e.id);
        const typical=typicalDaySales(history,date,today,{weeks:8,exclude});
        let lastTime:(LastTimeOutlook&{holiday:string})|null=null;
        for(const h of onDay){
          const d=lastYear.get(h.key+"|"+h.date);
          const found=d?lastTimeOutlook(history,d,exclude):null;
          if(found){lastTime={...found,holiday:h.name};break;}
        }
        days.push({date,weekday:WEEKDAYS[weekdayOf(date)],daysFromToday:daysBetween(today,date),
          ...(onDay.length?{holidays:onDay.map((h:HolidayDay)=>({name:h.name,kind:h.kind,usualEffect:h.usualEffect,why:h.why}))}:{}),
          ...(eventIds.length?{eventIds}:{}),
          typicalSalesCents:typical.typicalCents,typicalSampleDays:typical.sampleDays,
          ...(onDay.length?{lastTime}:{})});
      }
      if(history.length&&days.every(d=>d.typicalSalesCents===null))notCovered.push("notEnoughSalesHistory");
      if(!history.length&&recent!==null)notCovered.push("noSalesHistory");
      return {source:"nearby_events",period,agentId:"alex",unit:"cents",
        missing:location?[]:[CAFE_ADDRESS_FACT],notCovered:[...new Set(notCovered)],
        today,location:location?{label:location.label,source:location.source}:null,
        country:country.country,countrySource:country.source,
        typicalMeans:"median Toast net sales of the same weekday over the 8 weeks before today, holidays left out",
        days,localEvents:events,localEventsSearched:localEvents!==null};
    },
  },
} as const;
