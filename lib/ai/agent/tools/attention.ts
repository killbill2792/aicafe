import { z } from "zod";
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
      // Keep the UI/next-intl readers out of the agent registry module graph.
      // They are loaded only when this authenticated tool is actually called.
      const {getAttentionItems}=await import("@/lib/attention/getAttentionItems.server");
      const items=await getAttentionItems({period:"today",locale:ctx.locale});
      const byId=new Map(items.map(item=>[item.id,item]));
      const {visible,total}=prioritizeHomeAttention(items.map(item=>({
        id:item.id,title:item.displayTitle,href:item.href,
        impactCents:item.impactCents,actionLabel:item.actionLabel,
      })));
      return {source:"home_attention",period:{from:ctx.asOf,to:ctx.asOf},
        agentId:"alex",missing:[],
        total,items:visible.map(row=>byId.get(row.id)!) };
    },
  },
} as const;
