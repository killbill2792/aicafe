import {describe,it,expect} from "vitest";
import {scopedOwnerQuestionKey,questionFromReasons,answerFromSavedReasons} from "./questions";
import type {AskReason} from "./needsAsk";
import type {AgentToolResult} from "@/lib/ai/agent/tools";

describe("dated owner questions",()=>{
 it("saves a cost under the resolved item ID, not across the whole café",()=>{
  const reason:AskReason={kind:"missing",key:"unitCostCents",tool:"pricing_engine"};
  const latte:AgentToolResult={source:"pricing_engine",period:null,missing:["unitCostCents"],itemId:"latte-id"};
  const sandwich:AgentToolResult={source:"pricing_engine",period:null,missing:["unitCostCents"],itemId:"sandwich-id"};
  const first=questionFromReasons([reason],[latte],"What does the latte cost?","en",[]);
  const factKey=first?.fields[0].key;
  expect(first?.fields[0]).toMatchObject({key:"unit_cost_cents:item:latte-id",inputType:"money"});
  const stored=[{fact_key:factKey!,value_json:125,unit:"cents",period_scope:null,created_at:"2026-10-28T00:00:00Z"}];
  const next=questionFromReasons([reason],[sandwich],"What does the sandwich cost?","en",stored);
  expect(next?.fields[0].key).toBe("unit_cost_cents:item:sandwich-id");
 });
 it.each(["en","es","ar"] as const)("formats saved EUR answers in %s",locale=>{
  const reason:AskReason={kind:"missing",key:"payrollMissing",tool:"get_profit"};
  const stored=[{fact_key:"monthly_payroll_cents",value_json:12345,unit:"cents",period_scope:"month",created_at:"2026-10-28T00:00:00Z"}];
  const answer=answerFromSavedReasons([reason],[],"Payroll?",stored,locale,"EUR");
  expect(answer).toContain("€");
  expect(answer).not.toContain("$");
 });
 it.each([["en","almond milk"],["es","leche de almendra"],["ar","حليب اللوز"]] as const)(
  "milk cost card names the exact target in %s",(locale,translated)=>{
   const reason:AskReason={kind:"missing",
     key:"milk_almond_serving_cost_cents:16oz",tool:"milk_swap"};
   const card=questionFromReasons([reason],[],
     "Switch 16 oz to almond milk",locale,[]);
   expect(card).not.toBeNull();
   expect(card!.fields[0].label).toContain(translated);
   expect(card!.fields[0].key).toBe("milk_almond_serving_cost_cents:16oz");
   if(locale!=="en")expect(card!.fields[0].label).not.toContain("almond milk");
   expect(card!.fields[0].label).not.toContain("{milk}");
 });
 it("saved milk cost has no placeholder in any supported language",()=>{
  const key="milk_almond_serving_cost_cents:16oz";
  const reason:AskReason={kind:"missing",key,tool:"milk_swap"};
  const fact={fact_key:key,value_json:90,unit:"cents",period_scope:null,created_at:"2026-10-28T00:00:00Z"};
  for(const locale of ["en","es","ar"] as const){
   const answer=answerFromSavedReasons([reason],[],"Switch to almond milk",[fact],locale);
   expect(answer).not.toContain("{milk}");
   expect(answer).toContain(({en:"almond milk",es:"leche de almendra",ar:"حليب اللوز"})[locale]);
  }
 });
 const reason:AskReason={kind:"empty",key:"scheduled_shifts",tool:"scheduled_shifts"};
 const day=(date:string):AgentToolResult=>({source:"scheduled_shifts",
  period:{from:date,to:date},missing:[],shifts:[]});
 it("saves each schedule answer for its period, never globally",()=>{
  const first=scopedOwnerQuestionKey(reason,[day("2026-11-07")],"Who works Saturday?");
  const second=scopedOwnerQuestionKey(reason,[day("2026-11-14")],"Who works Saturday?");
  expect(first).toBe("schedule:2026-11-07:2026-11-07");
  expect(second).toBe("schedule:2026-11-14:2026-11-14");
  expect(first).not.toBe(second);
  const stored=[{fact_key:first,value_json:"Alex 9–5",created_at:"2026-11-07T00:00:00Z",
    unit:null,period_scope:null}];
  expect(questionFromReasons([reason],[day("2026-11-07")],
   "Who works Saturday?","en",stored)).toBeNull();
  const next=questionFromReasons([reason],[day("2026-11-14")],
   "Who works Saturday?","en",stored);
  expect(next?.fields[0]).toMatchObject({key:second,inputType:"text"});
 });
 it("saved facts replace refusals using the exact scoped question key",()=>{
  const toolResult:AgentToolResult={source:"menu_items",period:null,missing:[],items:[]};
  const ownerText="Which menu items can I price?";
  const reason:AskReason={kind:"empty",key:"menu_items",tool:"menu_items"};
  const key=scopedOwnerQuestionKey(reason,[toolResult],ownerText);
  const fact={fact_key:key,value_json:"Owner confirms three items",unit:null,
    period_scope:null,created_at:"2026-10-28T00:00:00Z"};
  const card=questionFromReasons([reason],[toolResult],ownerText,"en",[fact]);
  expect(card).toBeNull();
  const response=answerFromSavedReasons([reason],[toolResult],ownerText,[fact],"en");
  expect(response).toContain("Owner confirms three items");
 });
 it("does not reuse a generic default-estimate answer for an unrelated question",()=>{
  const basis:AskReason={kind:"missing",key:"query_data",tool:"query_data"};
  const first=scopedOwnerQuestionKey(basis,[],"What is oat milk cost?");
  const second=scopedOwnerQuestionKey(basis,[],"What is employee payroll?");
  expect(first).not.toBe(second);
 });
});
