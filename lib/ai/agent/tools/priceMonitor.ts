import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

export const priceMonitorTools={
  get_price_monitor_status:{
    agentId:"alex",
    schema:z.strictObject({}),
    description:"Read existing price-change and price-experiment monitoring status, including upcoming start dates and completed reports. Never create or restart an experiment.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      priceMonitorTools.get_price_monitor_status.schema.parse(raw);
      if(!ctx.readPriceMonitors)return {source:"supervisor_loop",period:null,missing:["monitor_reader_unavailable"],monitors:[]};
      try{
        const monitors=await ctx.readPriceMonitors();
        return {source:"supervisor_loop",period:null,agentId:"alex",missing:[],monitors};
      }catch{
        return {source:"supervisor_loop",period:null,agentId:"alex",missing:["monitor_read_failed"],monitors:[]};
      }
    },
  },
} as const;
