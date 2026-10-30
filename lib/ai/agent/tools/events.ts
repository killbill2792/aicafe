import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {buildEventsOutlook,hourlyOutlookRead} from "@/lib/events/outlook";
import {CAFE_ADDRESS_FACT} from "@/lib/data/cafeLocation.server";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {weekdayOf} from "@/lib/events/holidays";
import {mondayOfLocalDate} from "@/lib/scheduling/staffScope.server";
import {mergeScheduleShifts} from "./scheduleReads";

export const nearbyEventsInput=z.strictObject({
  start_date:z.iso.date().nullable(),
  days:z.number().int().min(1).max(10).nullable(),
});

/** "What's happening near my café?" Same builder as the Home "Coming up" card.
 * Read-only: it never changes a schedule; staffing changes stay propose_* cards. */
export const eventsTools={
  get_nearby_events:{
    agentId:"alex",schema:nearbyEventsInput,
    description:"Read-only facts for holidays and events near the signed-in café: dated names, event sources, venue/time, regular hours, same-weekday hourly Toast medians, last occurrence's sales, recorded top items, existing schedule and saved owner answers. No staffing decisions, forecasts or hard-coded holiday advice. Use for questions about upcoming days and busy hours; start_date null=today, days null=7. Never invent crowd counts or fill missing evidence with zero. If scheduleStatus is unavailable or partial, never interpret an empty scheduledPeople list as nobody scheduled; explain the incomplete schedule or Toast data. If hourlySalesQuality or notCovered reports partial POS data, qualify all affected historical hour medians and planning estimates. Give a useful AI-written plan immediately: expected busy hours (label estimates), 1–3 actions across staffing, prep, ordering, promotion, hours or operations with a reason grounded in these facts. If a holiday has no past history and no saved event answer, add at most one ask_owner kind=facts choice field named event_outcome:<holiday key>:<last year>, with 2–4 owner-friendly options (e.g. busy, normal, quiet, closed) and an Other response. The owner answer is saved and the same chat updates the plan. If the café address is missing still explain known holidays, then ask for cafe_address. Never pretend the AI's plan comes from code.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=nearbyEventsInput.parse(raw);
      const outlook=await buildEventsOutlook({today:ctx.asOf,timezone:ctx.timezone,locale:ctx.locale,
        from:input.start_date,days:input.days,readLocation:ctx.cafeLocation,search:ctx.searchNearbyEvents,
        readHourlySales:ctx.tools.getPeakHours?async(from,to)=>{
          const slice=await ctx.tools.getPeakHours!({from,to});
          return hourlyOutlookRead(slice);
        }:undefined,
        readSales:async(from,to)=>{
          const slice=await ctx.tools.getSalesTrend({from,to});
          return slice.available?slice.value.map(d=>({date:d.date,netSalesCents:d.netSalesCents})):[];
        }});
      if("tooFarAhead" in outlook)
        return {source:"nearby_events",period:null,agentId:"alex",missing:[],notCovered:["tooFarAhead"],maxDaysAhead:outlook.maxDaysAhead};
      const {from,to,addressMissing,...rest}=outlook;
      // The one existing readers supply context. Failed reads are unknown, not empty schedules.
      const hours=ctx.tools.getBusinessHours?await ctx.tools.getBusinessHours().catch(()=>null):null;
      const weeks=[...new Set(outlook.days.map(d=>mondayOfLocalDate(d.date)))];
      const schedules=await Promise.all(weeks.map(async week=>({
        week,result:ctx.readWeekSchedule?await ctx.readWeekSchedule(week).catch(()=>null):null
      })));
      const byWeek=new Map(schedules.map(({week,result})=>[week,result]));
      const scheduleUnavailableWeeks=schedules.filter(s=>!s.result?.ok).map(s=>s.week);
      const toastSchedulePartialWeeks=schedules.filter(s=>s.result?.ok&&s.result.data.posScheduleError)
        .map(s=>s.week);
      const pastDates=[...new Set(outlook.days.flatMap(d=>d.lastTime?[d.lastTime.date]:[]))];
      const pastItems=await Promise.all(pastDates.map(async date=>{
        const slice=ctx.tools.getProductSales?
          await ctx.tools.getProductSales({from:date,to:date}).catch(()=>null):null;
        return [date,slice?.available?[...slice.value].filter(x=>x.units>0)
          .sort((a,b)=>b.units-a.units).slice(0,3).map(x=>({name:x.name,units:x.units})):null] as const;
      }));
      const byPastDate=new Map(pastItems);
      const enriched=outlook.days.map(day=>{
        const intervals=hours?.available?hours.value[OPEN_HOURS_DAY_KEYS[weekdayOf(day.date)]]:undefined;
        const schedule=byWeek.get(mondayOfLocalDate(day.date));
        const scheduleStatus=!schedule?.ok?"unavailable":schedule.data.posScheduleError?"partial":"complete";
        const scheduledPeople=schedule?.ok?
          [...new Set(mergeScheduleShifts(schedule.data)
            .filter(shift=>shift.date===day.date).map(shift=>shift.employeeName))]:null;
        const savedAnswers=day.holidays.flatMap(h=>{
          const key="event_outcome:"+h.key+":"+(Number(day.date.slice(0,4))-1);
          const fact=ctx.ownerFacts?.find(f=>f.fact_key===key);
          return fact?[{key,value:fact.value_json}]:[];
        });
        return {...day,openingHours:intervals??null,scheduledPeople,scheduleStatus,
          lastHolidayTopItems:day.lastTime?byPastDate.get(day.lastTime.date)??null:null,
          savedAnswers,
          // Hourly medians are observations, not forecasts of the event day.
          usualHourlySales:day.usualHourlySales
            .sort((a,b)=>b.typicalCents-a.typicalCents).slice(0,4)
            .sort((a,b)=>a.hourLocal-b.hourLocal)};
      });
      return {source:"nearby_events",period:{from,to},agentId:"alex",unit:"cents",
        missing:addressMissing?[CAFE_ADDRESS_FACT]:[],
        typicalMeans:"median recorded Toast sales of the same weekday in the last 8 weeks; event effects are unknown",
        ...rest,days:enriched,
        notCovered:[...new Set([...outlook.notCovered,
          ...(hours?.available?[]:["openingHoursUnavailable"]),
          ...(scheduleUnavailableWeeks.length?["scheduleUnavailable"]:[]),
          ...(toastSchedulePartialWeeks.length?["toastScheduleReadFailed"]:[]),
          ...(pastDates.length&&pastItems.every(([,items])=>items===null)?["pastItemSalesUnavailable"]:[])])],
        scheduleUnavailableWeeks,toastSchedulePartialWeeks};
    },
  },
} as const;
