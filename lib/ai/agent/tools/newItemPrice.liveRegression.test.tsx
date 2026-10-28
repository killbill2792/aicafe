import {describe,it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {newItemPriceTools} from "./newItemPrice";
import {emptyOwnerInputs} from "./ownerInputs";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type {AgentToolContext} from "./index";
import {compactEvidence,checkNumbers} from "../checkNumbers";
import {acceptedExplainLines,type ExplainLine} from "../explain";
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
function context(override:Partial<Economics>={},ownerText=""):AgentToolContext{
 return {asOf:"2026-10-27",locale:"en",
  resolveState:{ownerText,ambiguous:[],seenIds:new Set(),chosenIds:new Set(),
   priorChoice:null,asked:false,usageMissing:new Map()},
  tools:{} as AgentToolContext["tools"],
  readEconomics:async()=>({economics:{...economics,...override},
    items:[],staff:[],ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null})
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
});
