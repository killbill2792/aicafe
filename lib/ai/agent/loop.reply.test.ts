import {describe,it,expect} from "vitest";
import {compactCalculationReply} from "@/lib/ownerFacts/reply";
import {agentReplyPayload} from "./persist.server";
import {runAgentTurn,type AgentTurn,type AgentProvider} from "./loop.server";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type {AgentToolContext} from "./tools";
import {money} from "./explain";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import HowIGotThis from "@/components/home/HowIGotThis";
describe("pricing answer compact contract",()=>{
 it("real agent pricing turn -> at most three lines and stored how block",async()=>{
  const economics:Economics={
   monthlyBills:figure(746700,"actual","recorded bills"),
   monthlyStaff:figure(600000,"actual","recorded wages"),
   monthlyRevenue:figure(3000000,"estimate","sales projection"),
   ingredientRate:.3,feeRate:.029,ingredientStatus:"actual",feeStatus:"actual",
   averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,targetMargin:.15,missingDays:[]
  };
  const context:AgentToolContext={asOf:"2026-10-28",locale:"en",timezone:"America/Los_Angeles",
   tools:{} as AgentToolContext["tools"],
   readEconomics:async()=>({economics,items:[],staff:[],
    ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null})};
  let step=0;
  const completed={type:"response.completed",response:{usage:{input_tokens:20,output_tokens:12}}};
  const provider:AgentProvider=async function*(request){
   step++;
   if(step===1){
    yield {type:"response.output_item.done",item:{type:"function_call",
     name:"suggest_new_item_price",call_id:"price-1",
     arguments:JSON.stringify({ingredient_cost_cents:145,category:"drink",packaging_cents:0,
       target_drink_cost_percent:null,operating_margin_percent:null,
       owner_monthly_bills_cents:null,item_name:"New latte",ownerInputs:null})}} as never;
   }else{
    const input=request.input as Array<{output?:string}>;
    const last=input.filter(x=>x.output).at(-1);
    const result=JSON.parse(last?.output??"{}") as {recommendedPriceCents?:number};
    const display=((result.recommendedPriceCents??500)/100).toFixed(2);
    yield {type:"response.output_text.delta",delta:
     "Recommended price: $"+display+". Ingredients cost $1.45. "+
     "Labor per drink is recorded. Bills are recorded. "+
     "Processing fees are included. Next, review before applying the price."} as never;
   }
   yield completed as never;
  };
  const turn=await runAgentTurn({ownerText:"What price for a new latte?",context,provider});
  expect(turn.text.split("\n").length).toBeLessThanOrEqual(3);
  expect(turn.text).toContain("Recommended price");
  const how=agentReplyPayload(turn).reply.blocks.find(x=>x.type==="how");
  expect(how&&"lines" in how?how.lines.length:0).toBeGreaterThan(0);
 });

 it("compacts a calculation even if its tool did not provide explain lines",async()=>{
  const context:AgentToolContext={asOf:"2026-10-28",locale:"en",
   timezone:"America/Los_Angeles",tools:{} as AgentToolContext["tools"]};
  // Unit regression of the same deterministic compactor for numeric tool data.
  const long="Revenue is $500. Fees were $10. Labor cost $60. "+
    "The margin is approximate. Next, confirm the totals.";
  expect(compactCalculationReply(long).split("\n")).toHaveLength(3);
  void context;
 });
 it("missing pricing payroll and bills -> one persisted money card, never text-only choice",async()=>{
  const e:Economics={
   monthlyBills:figure(null,"missing","missing monthly bills"),
   monthlyStaff:figure(null,"missing","missing wages"),
   monthlyRevenue:figure(3000000,"estimate","projection"),
   ingredientRate:.3,feeRate:.029,ingredientStatus:"actual",feeStatus:"actual",
   averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,targetMargin:.15,missingDays:[]
  };
  const context:AgentToolContext={asOf:"2026-10-28",locale:"en",timezone:"America/Los_Angeles",
   tools:{} as AgentToolContext["tools"],readEconomics:async()=>({
     economics:e,items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null
   })};
  const completed={type:"response.completed",response:{usage:{input_tokens:20,output_tokens:12}}};
  const provider:AgentProvider=async function*(){
   yield {type:"response.output_item.done",item:{type:"function_call",
    name:"suggest_new_item_price",call_id:"missing-pricing",
    arguments:JSON.stringify({ingredient_cost_cents:145,category:"drink",packaging_cents:0,
     target_drink_cost_percent:null,operating_margin_percent:null,
     owner_monthly_bills_cents:null,item_name:"New latte",ownerInputs:null})}} as never;
   yield completed as never;
  };
  const turn=await runAgentTurn({ownerText:"What price for a new latte?",context,provider});
  const card=turn.results.find(x=>x.source==="ask_owner");
  expect(card).toMatchObject({kind:"facts",missing:[]});
  const keys=(card?.fields as Array<{key:string}>).map(f=>f.key);
  expect(keys).toEqual(expect.arrayContaining(["monthly_payroll_cents","monthly_bills_cents"]));
  const payload=agentReplyPayload(turn);
  expect(payload.reply.blocks.some(block=>block.type==="clarify"&&block.kind==="facts")).toBe(true);
 });
 it("preserves localized read failures after compaction of a numeric answer",()=>{
  for(const [reply,error] of [
    ["Sales $500. Labor $120. Cost $50. Bills $90. I couldn't read staffing for October.",
     "I couldn't read staffing"],
    ["Ventas 500. Mano de obra 120. Coste 50. Gastos 90. No pude consultar turnos.",
     "No pude consultar turnos"],
    ["المبيعات ٥٠٠. العمالة ١٢٠. التكاليف ٥٠. المصاريف ٩٠. تعذرت قراءة الورديات.",
     "تعذرت قراءة الورديات"]
  ] as const){
   const compact=compactCalculationReply(reply);
   expect(compact.split("\n").length).toBeLessThanOrEqual(3);
   expect(compact).toContain(error);
  }
 });
 it("is at most three short lines and verified working stays in the how block",()=>{
  const verbose="Recommended price is $5.25. Ingredient cost is $1.50. "+
   "Monthly payroll is $10,000. Bills cost another $2,000. "+
   "The fee adds 10 cents. Next, confirm the price proposal.";
  const compact=compactCalculationReply(verbose);
  expect(compact.split("\n").length).toBeLessThanOrEqual(3);
  expect(compact).toContain("$5.25");
  const toolExplanation={label:"Recommended price",
    inputs:[{name:"productCost",value:money(150)},{name:"laborPerMonth",value:money(1000000)}],
    formula:"sum" as const,result:money(525),period:null,
    source:"suggest_new_item_price",provenance:"estimate" as const};
  const turn={text:compact,endReason:"complete",
    status:{status:"complete",basis:"actual",missing:[]},
    results:[{source:"new_item_price",period:null,missing:[],recommendedPriceCents:525}],
    unverified:[],explain:[toolExplanation],usage:{modelCalls:2,toolCalls:1,
      inputTokens:100,outputTokens:80,cachedTokens:0,latencyMs:50}
  } as unknown as AgentTurn;
  const how=agentReplyPayload(turn).reply.blocks.find(b=>b.type==="how");
  expect(how).toBeDefined();
  expect(how&&"lines" in how?how.lines:[]).toHaveLength(1);
 });
 it("how remains collapsed and localized for EN, ES and AR",()=>{
  const line={label:"Recommended price",inputs:[{name:"productCost",value:money(250)}],
    formula:"sum" as const,result:money(500),period:null,
    source:"suggest_new_item_price",provenance:"ownerProvided" as const,basis:"owner_provided"};
  for(const [locale,copy] of [["en",en.SupervisorChat],["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const){
   const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:[line],locale,copy}));
   expect(html).toContain("<details");
   expect(html).not.toContain("<details open");
   expect(html).toContain(locale==="en"?"Source:":locale==="es"?"Fuente:":"المصدر:");
  }
 });
});
