import { z } from "zod";
import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
import { prioritizeHomeAttention } from "@/components/home/homeAttention";
import type { AgentToolContext, AgentToolResult } from "./index";

const empty=z.strictObject({});
/** Read the exact actionable feed Home shows, using the session's active café.
 * The model never supplies a business ID, and no staff/sales inference is used. */
export const attentionTools={
  get_attention_items:{
    agentId:"alex",schema:empty,
    description:"Read the owner's current Home Needs your attention items and fix links. Always use for 'what needs my attention' and similar; do not infer tasks from labor, schedule or sales.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      const items=await getAttentionItems({period:"today",locale:ctx.locale});
      const {visible,total}=prioritizeHomeAttention(items);
      return {source:"home_attention",period:{from:ctx.asOf,to:ctx.asOf},
        agentId:"alex",missing:[],
        total,items:visible.map(item=>({
          id:item.id,kind:item.kind,agentId:item.agentId,source:item.source,
          title:item.title,displayTitle:item.displayTitle,href:item.href,
          impactCents:item.impactCents,actionLabel:item.actionLabel,
        }))};
    },
  },
} as const;
