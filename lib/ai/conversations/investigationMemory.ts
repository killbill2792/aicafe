import {z} from "zod";
import type {ConversationMessage} from "./contracts";

/** Navigation/owner context only. Never persisted balances, wages, derived numbers,
 * model-written summaries or grants. Every remembered read must execute again. */
export const investigationMemorySchema=z.strictObject({
  version:z.literal(1),businessId:z.string().min(1).max(120),
  ownerStatements:z.array(z.string().min(1).max(4000)).max(6),
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
