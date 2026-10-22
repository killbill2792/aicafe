import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";

const empty=z.strictObject({});
export const hoursTools={
  get_business_hours:{
    agentId:"olivia",schema:empty,
    description:"Read configured weekly location opening hours; if unset ask the owner, never guess.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getBusinessHours)return {source:"locations.open_hours",period:null,
        agentId:"olivia",missing:["businessHoursReaderUnavailable"],hours:null};
      const s=await ctx.tools.getBusinessHours();
      return {source:"locations.open_hours",period:null,agentId:"olivia",
        missing:s.available?s.quality.missingInputs:
          s.quality.missingInputs.length?s.quality.missingInputs:["businessHoursNotSet"],
        hours:s.available?s.value:null};
    },
  },
} as const;
