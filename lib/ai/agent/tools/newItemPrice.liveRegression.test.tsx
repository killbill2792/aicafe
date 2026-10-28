import {describe,it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {newItemPriceTools} from "./newItemPrice";
import {emptyOwnerInputs} from "./ownerInputs";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type {AgentToolContext} from "./index";
import {compactEvidence,checkNumbers} from "../checkNumbers";
import {acceptedExplainLines,type ExplainLine} from "../explain";
import {verifiedRecommendedPriceInReply} from "../pricingReply";
import HowIGotThis from "@/components/home/HowIGotThis";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

const economics:Economics={
 monthlyStaff:figure(514000,"estimate","Sparse: one of fourteen days has timecards"),
 monthlyBills:figure(836000,"actual","Recurring bills, five categories"),
 monthlyRevenue:figure(3000000,"estimate","Covered sales"),
 ingredientRate:.3,feeRate:.023,ingredientStatus:"actual",feeStatus:"actual",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:27,targetMargin:.15,
 missingDays:[],laborCoveredDays:1,laborWindowDays:14,
 salesCoverage:{from:"2026-08-22",to:"2026-09-04",openDays:14},
 missingBillCategories:[],
};
const item={ingredient_cost_cents:145,packaging_cents:0,category:"drink" as const,
 item_name:"New Latte",ownerInputs:null};
function context(override:Partial<Economics>={},ownerText="",
 locale:"en"|"es"|"ar"="en",savedTarget:number|null=null):AgentToolContext{
 return {asOf:"2026-10-27",locale,
  resolveState:{ownerText,ambiguous:[],seenIds:new Set(),chosenIds:new Set(),
   priorChoice:null,asked:false,usageMissing:new Map()},
  tools:{} as AgentToolContext["tools"],
  readEconomics:async()=>({economics:{...economics,...override},
    items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:savedTarget})
 } as AgentToolContext;
}
describe("new drink pricing: sparse Aug 22–Sep 4 regression",()=>{
 it("rejects a model margin and keeps a $5 baseline with insufficient labor coverage",async()=>{
  await expect(newItemPriceTools.suggest_new_item_price.execute({...item,target_margin_percent:50},
   context())).rejects.toThrow();
  const r=await newItemPriceTools.suggest_new_item_price.execute(item,context());
  expect(r.recommendedPriceCents).toBe(500);
  expect(r.breakEvenCents).toBeNull();
  expect(r.monthlyLabor).toMatchObject({status:"missing",valueCents:null});
  expect(r).toMatchObject({askOwnerRequired:true,needsOwnerChoice:true,allowOther:true});
  expect(r.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({id:"labor-monthly",label:"Provide monthly labor"})]));
 });
 it("uses owner $13,000/month to reach $5.25, full break-even $5.13, profit price $6.25",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}}};
  const r=await newItemPriceTools.suggest_new_item_price.execute(v,context());
  expect(r.recommendedPriceCents).toBe(525);
  expect(r.breakEvenCents).toBe(513);
  expect(r.profitPriceCents).toBe(625);
  expect(r.monthlyLabor).toMatchObject({status:"owner",valueCents:1300000});
  expect(r.warning).toBe("below_full_cost");
  expect(r.missing).toEqual([]);
  const lines=r.explain as ExplainLine[];
  expect(lines.map(l=>l.label)).toEqual(expect.arrayContaining([
   "Ingredients + packaging","Units/month","Labor/drink","Bills/drink",
   "Processing fee","Full loaded cost","Recommended price","Break-even",
   "Profit price (informational)"]));
  expect(lines.find(l=>l.label==="Labor/drink")?.provenance).toBe("ownerProvided");
  const allowed=r.numberEstimates as Array<{value:number;unit:string}>;
  for(const l of lines){
   for(const v of [l.result,...l.inputs.map(i=>i.value)]){
    const n=v.kind==="money"?{value:v.cents,unit:"cents"}:
     v.kind==="percent"?{value:v.bps,unit:"bps"}:
     v.kind==="count"?{value:v.n,unit:"count"}:null;
    if(n)expect(allowed).toContainEqual(expect.objectContaining(n));
   }
  }
  expect(checkNumbers("New Latte: $5.25. Full-cost floor is $5.13.","", [r],"en")).toEqual([]);
  const evidence=compactEvidence([r]);
  const selected=acceptedExplainLines(lines,evidence,"New Latte: $5.25.",[],"en",525);
  expect(selected).toHaveLength(lines.length);
  for(const [locale,copy,title] of [
    ["en",en.SupervisorChat,"How this was calculated"],
    ["es",es.SupervisorChat,"Cómo se calculó"],
    ["ar",ar.SupervisorChat,"كيف تم الحساب"]
  ] as const){
    const html=renderToStaticMarkup(createElement(HowIGotThis,{lines:selected,locale,copy}));
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain(title);
    expect(html).toContain(copy.explainYouToldMe);
    if(locale==="ar")expect(html).toContain('dir="rtl"');
  }
 });
 it("keeps the full verified breakdown for an ES 5,25 US$ reply but not $15.25",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}}};
  const result=await newItemPriceTools.suggest_new_item_price.execute(v,context({},"","es"));
  const evidence=compactEvidence([result]),lines=result.explain as ExplainLine[];
  const valid="Precio recomendado: 5,25 US$";
  expect(verifiedRecommendedPriceInReply(valid,525,"es",[])).toBe(true);
  expect(acceptedExplainLines(lines,evidence,valid,[],"es",525)).toHaveLength(lines.length);
  const html=renderToStaticMarkup(createElement(HowIGotThis,{
   lines:acceptedExplainLines(lines,evidence,valid,[],"es",525),locale:"es",copy:es.SupervisorChat}));
  expect(html).toContain(es.SupervisorChat.howCalculated);
  const wrong="$15.25";
  expect(verifiedRecommendedPriceInReply(wrong,525,"en",[])).toBe(false);
  expect(acceptedExplainLines(lines,evidence,wrong,[],"en",null)).toEqual([]);
 });
 it("only an explicitly stated 25% owner margin changes the informational profit line",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}},
   operating_margin_percent:25};
  const unstated=await newItemPriceTools.suggest_new_item_price.execute(v,context());
  expect(unstated.profitPriceCents).toBe(625);
  const owner=await newItemPriceTools.suggest_new_item_price.execute(v,
    context({},"Set operating margin to 25%"));
  expect(owner.recommendedPriceCents).toBe(525);
  expect(owner.profitPriceCents).toBe(700);
  expect((owner.explain as ExplainLine[]).find(l=>l.label==="Profit price (informational)")?.provenance)
    .toBe("ownerProvided");
 });
 it("marks partial bills incomplete and asks for them with existing choice candidates",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}}};
  const r=await newItemPriceTools.suggest_new_item_price.execute(v,
   context({missingBillCategories:["rent","insurance"]}));
  expect(r.billsPartial).toBe(true);
  expect(r.breakEvenCents).toBeNull();
  expect(r.recommendedPriceCents).toBe(500);
  expect(r.missing).toEqual(expect.arrayContaining(["monthlyBill:rent","monthlyBill:insurance"]));
  expect(r.candidates).toEqual(expect.arrayContaining([expect.objectContaining({id:"bills-monthly"})]));
  expect((r.explain as ExplainLine[]).find(l=>l.label==="Break-even")?.provenance).toBe("missing");
  const html=renderToStaticMarkup(createElement(HowIGotThis,{
   lines:r.explain as ExplainLine[],locale:"en",copy:en.SupervisorChat}));
  expect(html).toContain(en.SupervisorChat.explainMissing);
 });
 it("accepts verified owner total bills from the Other amount follow-up",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}},
   owner_monthly_bills_cents:836000};
  const r=await newItemPriceTools.suggest_new_item_price.execute(v,
   context({monthlyBills:figure(null,"missing","Missing rent and utilities"),
    missingBillCategories:["rent","utilities"]},"Monthly bills: $8360"));
  expect(r.billsPartial).toBe(false);
  expect(r.monthlyBills).toMatchObject({valueCents:836000,status:"owner"});
  expect(r.recommendedPriceCents).toBe(525);
  expect(r.breakEvenCents).toBe(513);
  const noEvidence=await newItemPriceTools.suggest_new_item_price.execute(v,
   context({missingBillCategories:["rent"]},"I did not enter an amount"));
  expect(noEvidence.billsPartial).toBe(true);
 });

 it("does not turn an owner's $13,000 labor statement into $13,000 bills",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}},
   owner_monthly_bills_cents:1300000};
  const result=await newItemPriceTools.suggest_new_item_price.execute(v,context({},"labor 13000/month"));
  expect(result.monthlyBills).toMatchObject({valueCents:836000,status:"actual"});
  expect(result.recommendedPriceCents).toBe(525);
  expect(result.breakEvenCents).toBe(513);
  expect(result.components).toMatchObject({bills:{source:"recorded"}});
  for(const [text,locale] of [["Facturas mensuales: 13000","es"],
   ["الفواتير الشهرية: ١٣٠٠٠","ar"]] as const){
   const valid=await newItemPriceTools.suggest_new_item_price.execute(v,context({},text,locale));
   expect(valid.monthlyBills).toMatchObject({status:"owner",valueCents:1300000});
  }
 });
 it("accounts for the saved 2.49% plus $0.15/order plan over two drinks per order",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}}};
  const plan={percentRate:.0249,fixedFeeCents:15,drinksPerOrder:2,processorLabel:"Owner card fees"};
  const result=await newItemPriceTools.suggest_new_item_price.execute(v,context({feePlan:plan}));
  expect(result.feeRate).toBe(.0249);
  expect(result.feePlan).toEqual(plan);
  const full=145+1300000/6000+836000/6000;
  expect(result.breakEvenCents).toBe(Math.ceil((full+7.5)/(1-.0249)));
  expect(result.recommendedPriceCents).toBe(525);
  expect(result.profitPriceCents).toBe(625);
  const lines=result.explain as ExplainLine[];
  const fee=lines.find(l=>l.label.startsWith("Processing fee:"))!;
  expect(fee.label).toContain("2.49%");
  expect(fee.label).toContain("$0.15/order");
  expect(fee.label).toContain("$0.08/drink");
  expect(fee.basis).toContain("Owner card fees");
  expect(fee.provenance).toBe("ownerProvided");
  expect((result.components as {fee:{source:string}}).fee.source).toBe("ownerProvided");
  expect(result.numberEstimates).toEqual(expect.arrayContaining([
   expect.objectContaining({value:15,unit:"cents",detail:"pricing"}),
   expect.objectContaining({value:249,unit:"bps",detail:"pricing"})]));
  expect((result.numberEstimates as Array<{detail:string}>).every(v=>v.detail==="pricing")).toBe(true);
  expect(checkNumbers("Suggested $5.25, fee 2.49% and $0.15.","", [result],"en")).toEqual([]);
  const fallback=await newItemPriceTools.suggest_new_item_price.execute(v,context());
  expect(fallback.feeRate).toBe(.023);
  expect(fallback.breakEvenCents).toBe(513);
 });
 it("labels a saved drink-cost target as owner-provided and localizes the short price note",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}}};
  for(const [locale,copy] of [["en",en.SupervisorChat],["es",es.SupervisorChat],
   ["ar",ar.SupervisorChat]] as const){
   const r=await newItemPriceTools.suggest_new_item_price.execute(v,context({},"",locale,.30));
   expect(r.pricingNote).toBe(copy.pricingNoteBelowFullCost);
   expect((r.components as {targetDrinkCost:{source:string,basis:string}}).targetDrinkCost)
    .toMatchObject({source:"ownerProvided",basis:copy.pricingSavedTarget});
   const missing=await newItemPriceTools.suggest_new_item_price.execute(item,context({},"",locale));
   expect(missing.pricingNote).toBe(copy.pricingNoteDrinkCost.replace("{percent}","30"));
  }
 });
 it("recognizes Spanish and Arabic explicit percentages only for informational profit",async()=>{
  const v={...item,ownerInputs:{...emptyOwnerInputs,laborCents:1300000,laborPeriod:{unit:"month" as const}},
   operating_margin_percent:25};
  for(const [text,locale] of [["margen operativo 25%","es"],["هامش الربح ٢٥٪","ar"]] as const){
   const r=await newItemPriceTools.suggest_new_item_price.execute(v,context({},text,locale));
   expect(r.profitPriceCents).toBe(700);
   expect(r.recommendedPriceCents).toBe(525);
  }
 });

});
