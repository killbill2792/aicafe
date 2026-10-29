import {describe,expect,it} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import {scopedOwnerQuestionKey} from "@/lib/ownerFacts/questions";
import type {AgentToolContext} from "./tools";

const completed={type:"response.completed",response:{usage:{input_tokens:8,output_tokens:10}}};
const say=(delta:string)=>({type:"response.output_text.delta",delta});
const call=(name:string,args:unknown,call_id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id}});
const base:AgentToolContext={locale:"en",timezone:"Europe/Madrid",asOf:"2026-10-28",currency:"EUR",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{level:"low",missingInputs:["payroll"],estimatedInputs:[],staleInputs:[]}})
 }};
function stream(rounds:unknown[][]):AgentProvider {
 let i=0;
 return async function*(){for(const event of rounds[i++]??[])yield event as never;};
}
function renderedText(turn:Awaited<ReturnType<typeof runAgentTurn>>){
 return agentReplyPayload(turn).reply.blocks.filter((b):b is Extract<typeof b,{type:"text"}>=>b.type==="text")
   .map(b=>b.text).join("");
}
const menuArgs={query:null,limit:null};
describe("full model-text passthrough: stream -> turn -> persistence payload -> displayed text",()=>{
 it.each([
  ["EN no data","I don't have that data."],
  ["ES no data","No tengo esos datos."],
  ["AR no data","ليس لدي هذه البيانات."],
  ["six-line calculation","Net sales €1,800.\nLabor €510.\nIngredients €340.\nCard fees €48.\nBills €200.\nEstimated profit €702."],
  ["combined profit + price, 5+ sentences",
   "The café earned €702 on Wednesday. The latte is priced at €4.50. Raising the price to €4.75 increases revenue. The contribution changes after card processing fees. Labor is based on actual recorded hours. I can check another period if helpful."],
  ["milk question","What milk would you like to compare? Regular, almond, and oat are recorded."]
 ] as const)("%s is byte-for-byte untouched",(label,modelText)=>{void label;
   return runAgentTurn({ownerText:"Show the business figures",context:{...base},
    provider:stream([[say(modelText.slice(0,Math.floor(modelText.length/2))),say(modelText.slice(Math.floor(modelText.length/2))),completed]])})
    .then(turn=>{
      expect(turn.text).toBe(modelText);
      expect(renderedText(turn)).toBe(modelText);
      expect(agentReplyPayload(turn).reply.blocks.filter(b=>b.type==="text").length).toBeGreaterThan(0);
    });
 });
 it("tool missing[] offers a separate card and keeps model text intact",async()=>{
  const modelText="I have the menu, but sales coverage is missing for this week.";
  const turn=await runAgentTurn({ownerText:"What can I price?",context:{...base},
   provider:stream([[call("get_menu_items",menuArgs,"menu"),completed],[say(modelText),completed]])});
  expect(turn.text).toBe(modelText);
  expect(renderedText(turn)).toBe(modelText);
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify")).toBe(true);
 });
 it("saved owner facts prevent repeated cards without replacing the model reply",async()=>{
  const key=scopedOwnerQuestionKey({kind:"empty",key:"menu_items",tool:"menu_items"},[],"What can I price?");
  const modelText="The owner confirmed there are no active products yet. Keep that fact for future conversations.";
  const turn=await runAgentTurn({ownerText:"What can I price?",context:{...base},
   ownerFacts:[{fact_key:key,value_json:"No menu items",unit:null,period_scope:null,created_at:"2026-10-28T09:00:00Z"}],
   provider:stream([[call("get_menu_items",menuArgs,"menu"),completed],[say(modelText),completed]])});
  expect(turn.text).toBe(modelText);expect(renderedText(turn)).toBe(modelText);
  expect(turn.results.some(r=>r.source==="ask_owner")).toBe(false);
 });
 it("tool or owner-fact read failure stays separate from the original model wording",async()=>{
  const modelText="No data.";
  const turn=await runAgentTurn({ownerText:"Payroll?",context:{...base},ownerFactsReadFailed:true,
   provider:stream([[say(modelText),completed]])});
  expect(turn.results).toEqual(expect.arrayContaining([expect.objectContaining({error:"owner_facts_read_failed"})]));
  expect(turn.text).toBe(modelText);expect(renderedText(turn)).toBe(modelText);
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify")).toBe(true);
 });
 it("when model says nothing at all, only a separate card question may fill the empty text",async()=>{
  const turn=await runAgentTurn({ownerText:"Menu?",context:{...base},
   provider:stream([[call("get_menu_items",menuArgs,"menu"),completed],[completed]])});
  const card=turn.results.find(r=>r.source==="ask_owner");
  expect(card?.question).toBeTruthy();
  expect(turn.text).toBe(card?.question);
  expect(renderedText(turn)).toBe(card?.question);
 });
 it("when the model itself repeats the card question, the text still renders",async()=>{
  const modelText="What items should I add to the menu?";
  const turn=await runAgentTurn({ownerText:"Menu?",context:{...base},
   provider:stream([[call("get_menu_items",menuArgs,"menu"),completed],[say(modelText),completed]])});
  expect(turn.text).toBe(modelText);expect(renderedText(turn)).toBe(modelText);
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify")).toBe(true);
 });
});
