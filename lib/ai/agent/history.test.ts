import {describe,expect,it} from "vitest";
import {historyContent} from "./history";
import {agentReplyPayload} from "./persist.server";
import {newResolveState} from "./resolve";
import type {AgentTurn} from "./loop.server";

// A reply that is only a question is saved as the card alone. The AI's next turn must
// still see that question, or it forgets what it just asked the owner.
const questionId="11111111-1111-4111-8111-111111111111";
const hot="22222222-2222-4222-8222-222222222222",iced="33333333-3333-4333-8333-333333333333";
function questionOnly(result:Record<string,unknown>&{question:string}){
 const turn={text:result.question,endReason:"complete",status:{status:"complete",missing:[]},
  results:[{source:"ask_owner",period:null,missing:[],...result}],unverified:[],
  usage:{modelCalls:1,toolCalls:1,inputTokens:1,cachedTokens:0,outputTokens:1,latencyMs:1}} as unknown as AgentTurn;
 return {text:null,blocks:agentReplyPayload(turn).reply.blocks};
}
const facts=questionOnly({kind:"facts",questionId,question:"What is your monthly rent?",
 fields:[{key:"monthly_rent_cents",label:"Monthly rent",inputType:"money",units:[],defaultUnit:""}]});
const fill=questionOnly({kind:"fill",question:"How much oat milk is left?",
 fields:[{key:"endCount:44444444-4444-4444-8444-444444444444:2026-10-29",label:"Oat milk",inputType:"number",units:["L"],defaultUnit:"L"}]});
const choice=questionOnly({kind:"choice",question:"Which latte?",allowOther:true,
 options:[{label:"Latte — Hot",value:hot},{label:"Latte — Iced",value:iced}]});

describe("chat history the AI sees",()=>{
 it("includes a typed-answer question that was the whole reply",()=>{
  expect(facts.blocks.some(b=>"type" in b&&b.type==="text")).toBe(false);
  expect(historyContent(facts)).toBe("Question card (owner answers in its form): What is your monthly rent? Fields: Monthly rent");
  expect(historyContent(fill)).toBe("Question card (owner answers in its form): How much oat milk is left? Fields: Oat milk");
 });
 it("keeps the exact choice-card form the pick memory reads",()=>{
  expect(historyContent(choice)).toBe("Asked: Which latte? Options: Latte — Hot ("+hot+"); Latte — Iced ("+iced+")");
  const state=newResolveState("Latte — Iced",[{role:"assistant",content:historyContent(choice)}]);
  expect([...state.chosenIds]).toEqual([iced]);
 });
 it("a typed-answer question is never read as a choice and keeps an earlier latte pick",()=>{
  for(const card of [facts,fill])
   expect(historyContent(card)).not.toMatch(/Asked:|Options:/);
  const history=[{role:"assistant",content:historyContent(choice)},{role:"user",content:"Latte — Hot"},
   {role:"assistant",content:historyContent(facts)},{role:"user",content:"Monthly rent: 3000"}];
  expect([...newResolveState("draft price change approval",history).recentChoiceIds??[]]).toEqual([hot]);
 });
 it("keeps plain text and text blocks as before",()=>{
  expect(historyContent({text:"Sales were up.",blocks:null})).toBe("Sales were up.");
  expect(historyContent({text:null,blocks:[{type:"text",text:"Part one."},{type:"text",text:"Part two."}]})).toBe("Part one. Part two.");
  expect(historyContent({text:null,blocks:[{type:"proposal_card",proposalId:questionId}]})).toBe("");
 });
});
