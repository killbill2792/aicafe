import {z} from "zod";
import {savedEventsTools} from "./getEvents";
import type {AgentToolContext,AgentToolResult} from "./index";

export const nearbyEventsInput=z.strictObject({
  start_date:z.iso.date().nullable(),
  days:z.number().int().min(1).max(10).nullable(),
});

/** Compatibility name only: it cannot discover or recompute event facts.
 * The canonical saved reader is the same one used by get_events and Home.
 * Fresh outside information belongs to the existing web_search tool. */
export const eventsTools={
  get_nearby_events:{
    agentId:"alex",
    schema:nearbyEventsInput,
    description:"Compatibility read of the SAME saved café and city Events timeline as get_events and Home. Never performs live nearby-event discovery. For fresh outside facts use web_search. Missing saved storage is unavailable, not no events.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=nearbyEventsInput.parse(raw);
      const from=input.start_date??ctx.asOf;
      const end=new Date(from+"T00:00:00Z");
      end.setUTCDate(end.getUTCDate()+(input.days??7)-1);
      const to=end.toISOString().slice(0,10);
      if(!ctx.savedEvents)return {source:"cafe_events",period:{from,to},
        agentId:"alex",missing:["savedEventsUnavailable"],searched:false};
      return savedEventsTools.get_events.execute({from,to},ctx);
    },
  },
} as const;
