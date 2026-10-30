import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import type {AgentToolContext} from "./tools";
import type {SavedFact} from "@/lib/ownerFacts/inject";
import {resumeOwnerQuestion} from "@/lib/ownerFacts/resume";
import {swapCostPerSize} from "@/lib/metrics/core/modifierPricing";

const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const say=(delta:string)=>({type:"response.output_text.delta",delta});
const call=(name:string,args:unknown,id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id:id}});
const fact=(fact_key:string,value_json:unknown):SavedFact=>({
 fact_key,value_json,created_at:"2026-10-28T00:00:00Z",unit:null,period_scope:null
});
const context:AgentToolContext={asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",currency:"EUR",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}})
 }
};
const args=(targetMilk:string)=>({targetMilk,baseMilk:null,sizes:["16 oz"]});
function fixture(rounds:Array<unknown[]>):AgentProvider{
 let i=0;
 return async function*(){
  for(const event of rounds[i++]??[])yield event as {type:string;[key:string]:unknown};
 };
}
const saved=(target:string)=>[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
 fact("milk_base_serving_cost_cents:16oz",40),
 fact("milk_"+target+"_serving_cost_cents:16oz",90)];
describe("model-driven milk swap in the real chat loop",()=>{
 it("registers tool calls and never overwrites either part of a combined profit + milk answer",async()=>{
  const turn=await runAgentTurn({
   ownerText:"What was profit last week and what should oat milk cost?",
   ownerFacts:saved("oat"),context:{...context},provider:fixture([
    [call("get_profit",{period:"last_week",ownerInputs:null},"p"),
     call("milk_swap_price",args("oat milk"),"m"),completed],
    [say("Last week's profit is not yet verified; oat milk 16 oz needs a €1.70 upcharge (estimate)."),completed]
   ])});
  expect(turn.tools).toContain("milk_swap_price");
  expect(turn.results.some(result=>result.source==="milk_swap")).toBe(true);
  expect(turn.text.toLowerCase()).toContain("profit");
  expect(turn.text.toLowerCase()).toContain("oat milk");
 });
 it("recovers an unsavable global cost card with an owner-saveable question",async()=>{
  const turn=await runAgentTurn({ownerText:"What does the latte cost?",
   context:{...context},provider:fixture([
    [call("ask_owner",{kind:"facts",question:"Cost?",options:[],allowOther:false,
     fields:[{key:"unitCostCents",label:"Cost",inputType:"money",units:[],defaultUnit:""}]},"bad"),completed],
    // The rejected card does not use up the turn's question, so the AI can ask again.
    [call("ask_owner",{kind:"facts",question:"What does one latte cost you to make?",options:[],allowOther:false,
     fields:[{key:"owner_question_latte_cost",label:"Latte cost",inputType:"text",units:[],defaultUnit:""}]},"retry"),completed]
   ])});
  const card=turn.results.find(r=>r.source==="ask_owner"&&r.kind==="facts");
  expect(card).toBeDefined();
  expect((card?.fields as Array<{key:string}>)[0].key).toMatch(/^owner_question_/);
  expect((card?.fields as Array<{inputType:string}>)[0].inputType).toBe("text");
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.error==="invalidFactFields")).toBe(true);
 });
 it("does not run a post-model regex intent router or assign canned milk text",()=>{
  const source=readFileSync(join(process.cwd(),"lib/ai/agent/loop.server.ts"),"utf8");
  expect(source).not.toContain("isMilkSwapQuestion");
  expect(source).not.toContain("text=summary");
  expect(source).not.toContain("text=copy.milkNoSize");
  expect(source).not.toContain("shared-milk-swap");
 });
 it.each(["oat","almond","soy","coconut","macadamia"])("uses the named %s milk without an oat default",async target=>{
  const facts=saved(target);
  const turn=await runAgentTurn({ownerText:"Milk upcharge for "+target,
   context:{...context},ownerFacts:facts,provider:fixture([
    [call("milk_swap_price",args(target+" milk"),"m"),completed],
    [say(target+" milk 16 oz suggested upcharge €1.70 (estimate)."),completed]
   ])});
  const result=turn.results.find(r=>r.source==="milk_swap");
  expect(result?.missing).toEqual([]);
  expect(result?.targetMilk).toBe(target+" milk");
  const row=(result?.rows as Array<{suggestedUpchargeCents:number}>)[0];
  expect(row.suggestedUpchargeCents).toBe(170);
 });
 it("ask → card → saved answers → original request resumes with numbers in the next turn",async()=>{
  const original="What should I charge to switch a 16 oz latte to almond milk?";
  const asked=await runAgentTurn({ownerText:original,context:{...context},provider:fixture([
   [call("milk_swap_price",args("almond milk"),"m"),completed],
   [say("I'll need the almond milk cost per 16 oz serving."),
    call("ask_owner",{kind:"facts",question:"What does almond milk cost per 16 oz serving?",options:[],allowOther:false,
     fields:[{key:"milk_almond_serving_cost_cents:16oz",label:"Almond milk cost",inputType:"money",units:[],defaultUnit:""}]},"ask"),completed]
  ])});
  const card=asked.results.find(r=>r.source==="ask_owner"&&r.kind==="facts");
  expect(card).toBeDefined();
  expect((card?.fields as Array<{key:string}>).map(f=>f.key)).toContain("milk_almond_serving_cost_cents:16oz");
  expect(agentReplyPayload(asked).reply.blocks.some(b=>b.type==="clarify"&&b.kind==="facts")).toBe(true);
  const resumed=resumeOwnerQuestion(original,"Saved",[{label:"Almond milk per serving",value:"0.90"}]);
  expect(resumed).toContain(original);
  const second=await runAgentTurn({ownerText:resumed,context:{...context},ownerFacts:saved("almond"),
   provider:fixture([
    [call("milk_swap_price",args("almond milk"),"m"),completed],
    [say("Almond milk 16 oz: suggested upcharge €1.70 (estimate)."),completed]
   ])});
  expect(second.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(false);
  const row=(second.results.find(r=>r.source==="milk_swap")?.rows as Array<{suggestedUpchargeCents:number}>)[0];
  const screen=swapCostPerSize([{id:"16oz",label:"16 oz"}],"whole milk","almond milk",
   {"16oz":{ml:160,basis:"owner_provided"}},
   {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},
    "almond milk":{costPerMlMicros:562500,basis:"owner_provided"}}).sizes[0];
  expect(row.suggestedUpchargeCents).toBe(screen.suggestedUpchargeCents);
  expect(second.text).toContain("€1.70");
 });
});
