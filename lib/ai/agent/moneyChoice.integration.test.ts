import {describe,it,expect} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./tools";
import {askOwnerTools} from "./tools/askOwner";
import {newResolveState,observeToolResult,type ChoiceCandidate} from "./resolve";
import {salesTools} from "./tools/sales";

const productId="11111111-1111-4111-8111-111111111111";
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const yes=<T>(value:T)=>({available:true as const,value,quality});
const ownerInputs={netSalesCents:30000,salesPeriod:{from:"2026-10-01",to:"2026-10-24"},
  laborCents:null,laborPeriod:null,rentCents:null,otherOverheadCents:null,
  overheadPeriod:null,unitCostCents:200,itemsSoldPerDay:null};
const recommendation={
  productCostCents:100,baselinePriceCents:575,calculatedSuggestedPriceCents:600,
  currentPriceCents:550,recommendedPriceCents:600,calculationMode:"BUSINESS_ADJUSTED" as const,
  businessAdjustmentFactor:1.02,confidence:"HIGH" as const,status:"NEW_PRICE" as const,
  explanationCode:"BUSINESS_ADJUSTED_EXPLAINER" as const,assumptions:[],signals:[],
  explanationInputs:{},warnings:[],
  dataQuality:{...quality},
};
const makeContext=():AgentToolContext=>({asOf:"2026-10-24",locale:"en",
  timezone:"America/Los_Angeles",tools:{
    getProfitability:async()=>yes({netSalesCents:20000,totalCostsCents:10000,
      ownerProfitCents:10000,operatingMargin:0.5,coveredSalesDays:24,expectedSalesDays:24}),
    getSalesTrend:async()=>yes([{date:"2026-10-24",netSalesCents:20000}]),
    getMenuCatalog:async()=>yes([{id:productId,name:"Latte",active:true,category:"drink",priceCents:550}]),
    getPricingRecommendation:async()=>yes(recommendation),
  }});
function optionsFrom(result:{candidates?:unknown}) {
  return (result.candidates as ChoiceCandidate[]).map(x=>({label:x.label,value:x.id}));
}
function choiceReply(question:string,options:ReturnType<typeof optionsFrom>,index:number) {
  const content="Asked: "+question+" Options: "+options.map(x=>x.label+" ("+x.value+")").join("; ");
  return newResolveState(options[index].label,[{role:"assistant",content}]);
}

describe("trusted owner-vs-recorded monetary clarification",()=>{
 it("runs sales conflict → validated card → owner-selected fact without inventing profit",async()=>{
   const context=makeContext();
   context.resolveState=newResolveState("I had $300 in sales, not $200");
   const first=await executeAgentTool("get_profit",{period:"month",ownerInputs},context);
   expect(first.needsOwnerChoice).toBe(true);
   expect(first.missing).toContain("ownerChoiceRequired");
   expect(first.netSalesCents).toBeNull();
   observeToolResult(context.resolveState,first);
   const options=optionsFrom(first);
   const card=await askOwnerTools.ask_owner.execute({
     question:"Which sales value should I use?",options,allowOther:false},context);
   expect(card.missing).toEqual([]);
   context.resolveState=choiceReply("Which sales value should I use?",options,1);
   const chosen=await executeAgentTool("get_profit",{period:"month",ownerInputs:null},context);
   expect(chosen).toMatchObject({selectedMoneySource:"ownerProvided",netSalesCents:30000,
     ownerProfitCents:null,totalCostsCents:null,needsOwnerChoice:false});
   expect(chosen.missing).toContain("recordedProfitNotApplicable");
   context.resolveState=choiceReply("Which sales value should I use?",options,0);
   const recorded=await executeAgentTool("get_profit",{period:"month",ownerInputs:null},context);
   expect(recorded).toMatchObject({selectedMoneySource:"recorded",netSalesCents:20000,
     ownerProfitCents:10000,needsOwnerChoice:false});
 });
 it("requires a fresh choice if recorded sales change after the card",async()=>{
   const ctx=makeContext();ctx.resolveState=newResolveState("My sales were $300");
   const first=await executeAgentTool("get_profit",{period:"month",ownerInputs},ctx);
   const opts=optionsFrom(first);ctx.resolveState=choiceReply("Select sales",opts,1);
   ctx.tools.getProfitability=async()=>yes({netSalesCents:21000,totalCostsCents:10000,
      ownerProfitCents:11000,operatingMargin:0.52,coveredSalesDays:24,expectedSalesDays:24});
   const answer=await executeAgentTool("get_profit",{period:"month",ownerInputs:null},ctx);
   expect(answer.missing).toContain("sourceChoiceExpired");
   expect(answer.netSalesCents).toBeUndefined();
 });
 it("runs cost conflict → trusted card → owner cost, suppressing stale recommendation",async()=>{
   const ctx=makeContext();ctx.resolveState=newResolveState("Latte ingredients cost $2, not $1");
   const first=await salesTools.get_price_recommendation.execute({itemId:productId,ownerInputs},ctx);
   expect(first.needsOwnerChoice).toBe(true);
   expect(first.missing).toContain("ownerChoiceRequired");
   observeToolResult(ctx.resolveState,first);
   const options=optionsFrom(first);
   const card=await askOwnerTools.ask_owner.execute({
     question:"Which unit cost should I use?",options,allowOther:false},ctx);
   expect(card.missing).toEqual([]);
   ctx.resolveState=choiceReply("Which unit cost should I use?",options,1);
   const chosen=await salesTools.get_price_recommendation.execute({
     itemId:productId,ownerInputs:null},ctx);
   expect(chosen).toMatchObject({selectedMoneySource:"ownerProvided",
     productCostCents:200,recommendedPriceCents:null,
     grossProfitPerItemCents:350,needsOwnerChoice:false});
   expect(chosen.missing).toContain("pricingNeedsRecalculationWithOwnerCost");
   ctx.resolveState=choiceReply("Which unit cost should I use?",options,0);
   const recorded=await salesTools.get_price_recommendation.execute({itemId:productId,ownerInputs:null},ctx);
   expect(recorded).toMatchObject({selectedMoneySource:"recorded",productCostCents:100,
     recommendedPriceCents:600,needsOwnerChoice:false});
 });
 it("rejects invented option labels or source IDs not found in trusted tool results",async()=>{
   const ctx=makeContext();ctx.resolveState=newResolveState("Sales mismatch");
   const first=await executeAgentTool("get_profit",{period:"month",ownerInputs},ctx);
   observeToolResult(ctx.resolveState,first);
   const options=optionsFrom(first);
   const untrusted=await askOwnerTools.ask_owner.execute({question:"Which value?",
     options:[{...options[0],label:"Verified and approved" },options[1]],allowOther:false},ctx);
   expect(untrusted.error).toBe("notFromTool");
 });
});
