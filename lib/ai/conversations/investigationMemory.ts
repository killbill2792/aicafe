import {z} from "zod";
import type {ConversationMessage} from "./contracts";

/** Navigation/owner context only. Never persisted balances, wages, derived numbers,
 * model-written summaries or grants. Every remembered read must execute again. */
export const investigationCalendarScopeSchema=z.discriminatedUnion("kind",[
  z.strictObject({domain:z.string().min(1).max(120),kind:z.literal("period"),from:z.string().date(),to:z.string().date()}),
  z.strictObject({domain:z.string().min(1).max(120),kind:z.literal("week"),week:z.string().date()}),
]);
export type InvestigationCalendarScope=z.infer<typeof investigationCalendarScopeSchema>;
/** Authenticated selector provenance. Ties a date override to the original
 * owner goal and registered reader without storing financial observations. */
const calendarScopeOriginSchema=z.strictObject({domain:z.string().min(1).max(120),
  kind:z.enum(["period","week"]),requestKey:z.string().regex(/^[a-f0-9]{64}$/),
  capabilityId:z.string().min(1).max(120)});
export const investigationMemorySchema=z.strictObject({
  version:z.literal(1),businessId:z.string().min(1).max(120),
  // Unique to this owner-request instance; chained durable answers reuse it.
  // Identical wording in a newly authored request must start a new instance.
  requestKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ownerStatements:z.array(z.string().min(1).max(4000)).max(6),
  calendarScopes:z.array(investigationCalendarScopeSchema).max(5).optional(),
  calendarScopeOrigins:z.array(calendarScopeOriginSchema).max(5).optional(),
  reads:z.array(z.strictObject({capabilityId:z.string().min(1).max(120),
    inputJson:z.string().min(2).max(6000)})).max(5),
});
export type InvestigationMemory=z.infer<typeof investigationMemorySchema>;
export function latestInvestigationMemory(messages:readonly ConversationMessage[],businessId:string,
  currentId:string):InvestigationMemory|undefined{
  const current=messages.findIndex(m=>m.id===currentId);
  const previous=current>=0?messages.slice(0,current):messages;
  for(const m of [...previous].reverse()){
    if(m.role!=="supervisor")continue;
    const parsed=investigationMemorySchema.safeParse(m.grounding?.investigationMemory);
    if(parsed.success&&parsed.data.businessId===businessId)return parsed.data;
  }
}

/** Merge persisted context with newer owner turns, including turns that failed
 * before a reply was saved. Compact history must not erase a fuller statement. */
export function investigationOwnerStatements(memory:InvestigationMemory|undefined,
  history:readonly {role:string;text:string}[],current:string):string[]{
  const statements=[...(memory?.ownerStatements??[])];
  for(const turn of history.filter(h=>h.role==="owner")){
    const index=statements.findIndex(s=>s===turn.text||turn.text.length>=650&&s.startsWith(turn.text));
    const full=index>=0?statements.splice(index,1)[0]:turn.text;
    statements.push(full);
  }
  if(statements.at(-1)!==current)statements.push(current);
  return statements.slice(-6);
}
