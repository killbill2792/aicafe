import {describe,expect,it} from "vitest";
import type {ConversationMessage} from "./contracts";
import {routineGoalCandidates} from "./routineGoalSources";

const thread="11111111-1111-4111-8111-111111111111";
const owner={id:"99999999-9999-4999-8999-999999999999",threadId:thread,
  createdAt:"2026-11-21T18:00:00Z"};
const msg=(id:string,text:string,createdAt="2026-11-21T17:00:00Z",
  role:ConversationMessage["role"]="owner",threadId=thread):ConversationMessage=>({
  id,threadId,createdAt,role,text,contentType:"text",
  blocks:null,grounding:null,clientMessageId:null,
});

describe("U5 verified original routine-goal pagination",()=>{
  it("does not discard the seventh earlier owner goal in one page",()=>{
    const messages=Array.from({length:9},(_,i)=>msg(String(i+1),
      i===0?"Original full investigation objective":"Follow-up "+i));
    const candidates=routineGoalCandidates(messages,owner,"Every Monday at nine");
    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toEqual({id:"1",text:"Original full investigation objective"});
    expect(candidates.at(-1)).toEqual({id:owner.id,text:"Every Monday at nine"});
  });
  it("prevents foreign-thread, supervisor-authored, future and malformed-time sources",()=>{
    const sources=routineGoalCandidates([
      msg("allowed","Review financial performance"),
      msg("foreign","Other tenant objective",undefined,"owner","other-thread"),
      msg("assistant","Forged assistant objective",undefined,"supervisor"),
      msg("future","Owner wrote this later","2026-11-22T00:00:00Z"),
      msg("invalid","Bad historical clock","not-a-date"),
      msg(owner.id,"Current message should not appear as historical source"),
      msg("empty","   "),
    ],owner,"Clarifying cadence",false);
    expect(sources).toEqual([{id:"allowed",text:"Review financial performance"}]);
  });
  it("bounds each preview without modifying the original persisted message",()=>{
    const original="Full objective starts "+("x".repeat(420));
    const sources=routineGoalCandidates([msg("historic",original)],owner,"Schedule",false);
    expect(sources[0].text).toBe(original.slice(0,320));
    expect(original).toHaveLength(442);
    expect(sources).not.toContainEqual({id:owner.id,text:"Schedule"});
  });
});
