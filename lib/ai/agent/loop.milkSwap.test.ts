import {describe,it,expect} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {agentReplyPayload} from "./persist.server";
import type {AgentToolContext} from "./tools";
import type {SavedFact} from "@/lib/ownerFacts/inject";
import {swapCostPerSize} from "@/lib/metrics/core/modifierPricing";
const completed={type:"response.completed",response:{usage:{input_tokens:10,output_tokens:10}}};
const say=(delta:string)=>({type:"response.output_text.delta",delta});
const fact=(fact_key:string,value_json:unknown):SavedFact=>({
 fact_key,value_json,created_at:"2026-10-28T00:00:00Z",unit:null,period_scope:null
});
const context:AgentToolContext={asOf:"2026-10-28",timezone:"America/Los_Angeles",locale:"en",
 tools:{
  getMenuCatalog:async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getSalesTrend:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  getProfitability:async()=>({available:false,value:null,quality:{level:"low",missingInputs:[],estimatedInputs:[],staleInputs:[]}})
 }
};
const fake:AgentProvider=async function*(){yield say("I need to verify that.");yield completed;};
describe("milk swap in the real chat loop",()=>{
 it("almond milk swap uses shared B function and missing cost gets one almond card",async()=>{
  const asked=await runAgentTurn({ownerText:"Switch 16 oz latte to almond milk; what upcharge?",
    context:{...context},provider:fake});
  const cards=asked.results.filter(r=>r.source==="ask_owner"&&r.kind==="facts");
  expect(cards).toHaveLength(1);
  expect(cards[0].fields).toEqual(expect.arrayContaining([
    expect.objectContaining({key:"milk_almond_serving_cost_cents:16oz",inputType:"money"})
  ]));
  expect(JSON.stringify(cards[0].fields)).not.toContain("milk_oat_serving_cost_cents");
  const facts=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
    fact("milk_base_serving_cost_cents:16oz",40),
    fact("milk_almond_serving_cost_cents:16oz",90)];
  const answered=await runAgentTurn({ownerText:"Switch 16 oz latte to almond milk; what upcharge?",
    ownerFacts:facts,context:{...context},provider:fake,history:[]});
  expect(answered.results.some(r=>r.source==="ask_owner")).toBe(false);
  const priced=answered.results.find(r=>r.source==="milk_swap")?.rows as Array<{
    suggestedUpchargeCents:number}>;
  const screen=swapCostPerSize([{id:"16oz",label:"16 oz"}],"whole milk","almond milk",
    {"16oz":{ml:160,basis:"owner_provided"}},
    {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},
      "almond milk":{costPerMlMicros:562500,basis:"owner_provided"}}).sizes[0];
  expect(priced[0].suggestedUpchargeCents).toBe(screen.suggestedUpchargeCents);
  expect(answered.text).toContain("almond milk");
 });
 it("milk cost missing -> partial answer and one card with all missing fields",async()=>{
  const turn=await runAgentTurn({ownerText:"Switch 16 oz latte to oat milk; what upcharge?",
    context:{...context},provider:fake});
  const cards=turn.results.filter(r=>r.source==="ask_owner"&&r.kind==="facts");
  expect(cards).toHaveLength(1);
  expect(cards[0].fields).toEqual(expect.arrayContaining([
   expect.objectContaining({key:"milk_base_type",inputType:"text"}),
   expect.objectContaining({key:"milk_ml:16oz",inputType:"number"}),
   expect.objectContaining({key:"milk_oat_serving_cost_cents:16oz",inputType:"money"}),
   expect.objectContaining({key:"milk_base_serving_cost_cents:16oz",inputType:"money"})
  ]));
  expect((cards[0].fields as Array<{label:string}>).every(field=>field.label.includes("16 oz")||
    field.label.toLowerCase().includes("milk"))).toBe(true);
  expect(turn.text).toContain("more information");
  expect(agentReplyPayload(turn).reply.blocks.some(b=>b.type==="clarify"&&b.kind==="facts")).toBe(true);
 });
 it("does not turn ingredient read exceptions into successful empty evidence",async()=>{
  const turn=await runAgentTurn({ownerText:"Switch 16 oz latte to oat milk; what upcharge?",
   context:{...context,tools:{...context.tools,getIngredientCosts:async()=>{throw new Error("database down");}}},
   provider:fake});
  expect(turn.results.some(r=>r.source==="ingredient_prices"&&r.error==="ingredient_read_failed")).toBe(true);
  expect(turn.text).toContain("I couldn't read");
  expect(turn.results.some(r=>r.source==="ask_owner"&&r.kind==="facts")).toBe(true);
 });
 it("multiple complete sizes stay visible in the short answer",async()=>{
  const saved=[fact("milk_base_type","whole milk"),
   ...[["8oz",80,20,35],["12oz",120,30,55],["16oz",160,40,90]].flatMap(([size,ml,base,oat])=>[
    fact("milk_ml:"+size,ml),fact("milk_base_serving_cost_cents:"+size,base),
    fact("milk_oat_serving_cost_cents:"+size,oat)])];
  const turn=await runAgentTurn({ownerText:"Switch 8 oz, 12 oz and 16 oz to oat milk; what upcharge?",
   ownerFacts:saved,context:{...context},provider:fake});
  expect(turn.text).toContain("8 oz");
  expect(turn.text).toContain("12 oz");
  expect(turn.text).toContain("16 oz");
  expect(turn.text.split("\n").length).toBeLessThanOrEqual(3);
 });
 it("after owner answered, NEW thread reuses facts and has no card",async()=>{
  const saved=[fact("milk_base_type","whole milk"),fact("milk_ml:16oz",160),
    fact("milk_base_serving_cost_cents:16oz",40),
    fact("milk_oat_serving_cost_cents:16oz",90)];
  const turn=await runAgentTurn({ownerText:"Switch 16 oz latte to oat milk; what upcharge?",
    ownerFacts:saved,context:{...context},provider:fake,history:[]});
  expect(turn.results.some(r=>r.source==="ask_owner")).toBe(false);
  expect(turn.results.find(r=>r.source==="milk_swap")).toMatchObject({missing:[],rows:[
    expect.objectContaining({sizeId:"16oz",suggestedUpchargeCents:expect.any(Number)})]});
  expect(turn.text).toContain("16 oz");
  expect(turn.text).toContain("upcharge");
  const expected=swapCostPerSize([{id:"16oz",label:"16 oz"}],"whole milk","oat milk",
   {"16oz":{ml:160,basis:"owner_provided"}},
   {"whole milk":{costPerMlMicros:250000,basis:"owner_provided"},
    "oat milk":{costPerMlMicros:562500,basis:"owner_provided"}}).sizes[0].suggestedUpchargeCents;
  expect((turn.results.find(r=>r.source==="milk_swap")?.rows as Array<{
    suggestedUpchargeCents:number}>)[0].suggestedUpchargeCents).toBe(expected);
 });
});
