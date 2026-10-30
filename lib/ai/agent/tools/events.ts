import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {buildEventsOutlook} from "@/lib/events/outlook";
import {CAFE_ADDRESS_FACT} from "@/lib/data/cafeLocation.server";

export const nearbyEventsInput=z.strictObject({
  start_date:z.iso.date().nullable(),
  days:z.number().int().min(1).max(10).nullable(),
});

/** "What's happening near my café?" Same builder as the Home "Coming up" card.
 * Read-only: it never changes a schedule; staffing changes stay propose_* cards. */
export const eventsTools={
  get_nearby_events:{
    agentId:"alex",schema:nearbyEventsInput,
    description:"Holidays, observances (e.g. Halloween, Labor Day) and local events near the café (festivals, conferences, games, parades, road closures) for the coming days, each with a decision (expect busier/quieter/normal/unsure; action add_staff/keep_staff_light/normal_staff/have_backup) and what similar days brought in the café's own Toast sales. "+
      "Use for: events nearby, anything happening this week/weekend, holidays, will it be busy, how many staff to plan. start_date null = today; days null = 7 (max 10). "+
      "If missing has cafe_address, the café address is unknown: still give the holiday part, then call ask_owner kind=facts with one text field key cafe_address asking for the café's street address, city and ZIP/postal code. "+
      "Answer like a manager, short: only notable days, today/tomorrow first. For each: what is happening, the decision in plain words, and why in one clause. "+
      "Use the decision as given; never contradict it. basis your_sales → cite lastTime.changePercent (their Toast sales last time); nearby_event → name the event and its source site; general_pattern → say it is a general pattern, not their data yet. "+
      "Never invent crowd sizes, dates or events. For how many people are scheduled, also call get_week_schedule.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=nearbyEventsInput.parse(raw);
      const outlook=await buildEventsOutlook({today:ctx.asOf,timezone:ctx.timezone,locale:ctx.locale,
        from:input.start_date,days:input.days,readLocation:ctx.cafeLocation,search:ctx.searchNearbyEvents,
        readSales:async(from,to)=>{
          const slice=await ctx.tools.getSalesTrend({from,to});
          return slice.available?slice.value.map(d=>({date:d.date,netSalesCents:d.netSalesCents})):[];
        }});
      if("tooFarAhead" in outlook)
        return {source:"nearby_events",period:null,agentId:"alex",missing:[],notCovered:["tooFarAhead"],maxDaysAhead:outlook.maxDaysAhead};
      const {from,to,addressMissing,...rest}=outlook;
      return {source:"nearby_events",period:{from,to},agentId:"alex",unit:"cents",
        // Only what the owner can answer goes in missing: it becomes a question card.
        missing:addressMissing?[CAFE_ADDRESS_FACT]:[],
        typicalMeans:"median Toast net sales of the same weekday over the 8 weeks before today, holidays left out",
        ...rest};
    },
  },
} as const;
