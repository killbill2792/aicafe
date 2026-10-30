import {describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ClarifyCard from "./ClarifyCard";
import {clarifyCardState} from "./supervisorChatBehavior";
import {agentReplyPayload} from "@/lib/ai/agent/persist.server";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {clarifyBlockSchema,type ConversationMessage} from "@/lib/ai/conversations/contracts";
import en from "@/messages/en.json";

// Owner report (Oct 29): "what is my breakeven cost?" and "monitor for 7 days" showed an
// empty Supervisor bubble. The AI's whole reply was a question, which is saved as the card
// alone, and the chat hid every card that had no option buttons.
const questionId="11111111-1111-4111-8111-111111111111";
const cards={
 facts:{source:"ask_owner",period:null,missing:[],kind:"facts",questionId,question:"What is your monthly rent?",
  fields:[{key:"monthly_rent_cents",label:"Monthly rent",inputType:"money",units:[],defaultUnit:""}]},
 fill:{source:"ask_owner",period:null,missing:[],kind:"fill",question:"How much oat milk is left?",
  fields:[{key:"endCount:22222222-2222-4222-8222-222222222222:2026-10-29",label:"Oat milk",inputType:"number",units:["L"],defaultUnit:"L"}]},
 choice:{source:"ask_owner",period:null,missing:[],kind:"choice",question:"Which latte?",allowOther:true,
  options:[{label:"Latte — Hot",value:"33333333-3333-4333-8333-333333333333"},{label:"Latte — Iced",value:"44444444-4444-4444-8444-444444444444"}]},
};
function questionOnlyTurn(result:(typeof cards)[keyof typeof cards]):AgentTurn{
 return {text:result.question,endReason:"complete",status:{status:"complete",missing:[]},results:[result],unverified:[],
  usage:{modelCalls:1,toolCalls:1,inputTokens:1,cachedTokens:0,outputTokens:1,latencyMs:1}} as AgentTurn;
}
const message=(role:"owner"|"supervisor",id:string,text:string|null,blocks:unknown[]|null=null):ConversationMessage=>({
 role,id,text,blocks,threadId:"thread",contentType:blocks?"blocks":"text",createdAt:"2026-10-29",grounding:null,clientMessageId:null});
const render=(blocks:unknown[],history:ConversationMessage[],index:number)=>{
 const parsed=blocks.map(b=>clarifyBlockSchema.safeParse(b)).find(p=>p.success);
 if(!parsed?.success)throw new Error("no saved card");
 const {state,choice}=clarifyCardState(history,index);
 return {state,markup:renderToStaticMarkup(createElement(ClarifyCard,{block:parsed.data,locale:"en",copy:en.SupervisorChat,
  state,choice,disabled:false,onSend:vi.fn(),onFacts:vi.fn()}))};
};

describe("a reply that is only a question is never blank",()=>{
 for(const [kind,result] of Object.entries(cards))it(kind+" card shows its question as the latest reply",()=>{
  const {reply}=agentReplyPayload(questionOnlyTurn(result));
  expect(reply.blocks.some(b=>"type" in b&&b.type==="text")).toBe(false);
  const history=[message("owner","a","what is my breakeven cost?"),message("supervisor","b",null,reply.blocks)];
  const {state,markup}=render(reply.blocks,history,1);
  expect(state).toBe("active");
  expect(markup).toContain(result.question);
 });
 for(const kind of ["facts","fill"] as const)it(kind+" card keeps its question after the owner moves on",()=>{
  const {reply}=agentReplyPayload(questionOnlyTurn(cards[kind]));
  const history=[message("supervisor","b",null,reply.blocks),message("owner","c","what were sales today?")];
  const {state,markup}=render(reply.blocks,history,0);
  expect(state).toBe("skipped");
  expect(markup).toContain(cards[kind].question);
  expect(markup).not.toContain("<button");
  expect(markup).not.toContain(en.SupervisorChat.clarifySkipped);
 });
});
