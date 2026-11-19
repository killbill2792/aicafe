import {eventReadinessInput} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import type {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Model proposes owner-reviewable wording; only the existing loop writes it. */
export type EventPlanPort={
  propose(input:z.infer<typeof eventReadinessInput>):Promise<{proposalId:string;revision:number;
    reused?:boolean;status?:string}>;
};

export const eventPlanTools={
  propose_event_plan:{
    agentId:"alex",schema:eventReadinessInput,
    description:"Draft inert preparation for confirmed event UUIDs, one date or a verified span with unchanged actions. Give café importance, summary, justified date-specific busy hours and 1–3 reasoned actions. Reuse prior decisions. No business change without owner approval.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=eventReadinessInput.parse(raw);
      if(!ctx.eventPlans)return {source:"event_plan_proposal",period:null,missing:["eventPlanningUnavailable"]};
      const result=await ctx.eventPlans.propose(input);
      return {source:"event_plan_proposal",period:{from:input.startDate,to:input.endDate},
        agentId:"alex",missing:[],draft:!result.reused,saved:false,...result};
    },
  },
} as const;
