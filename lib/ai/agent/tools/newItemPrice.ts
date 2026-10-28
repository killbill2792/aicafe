import {z} from "zod";
import {laborKnown} from "@/lib/calc";
import type {AgentToolContext,AgentToolResult} from "./index";
import {calculateNewItemPrice,contributionCoverage} from "@/lib/calc/newItemPrice";
import {requestedPeriod,prorate,periodDays,calendarMonth} from "@/lib/calc/periods";
import {ownerInputsSchema,ownerPeriod,ownerMonthlyAmount} from "./ownerInputs";
import {resolveCoveredSalesWindow} from "./coverage";
import {money,percent} from "../explain";
import {figure,recommendFullCostPrice} from "@/lib/calc/supervisorEconomics";
const schema=z.strictObject({
 ingredient_cost_cents:z.number().int().positive(),category:z.enum(["drink","food"]),
 packaging_cents:z.number().int().nonnegative().nullable(),
 target_margin_percent:z.number().min(0).max(60).nullable(),item_name:z.string().trim().max(120).nullable(),ownerInputs:ownerInputsSchema.nullable().optional()
});
export const newItemPriceTools={suggest_new_item_price:{
 agentId:"alex",schema,description:"Suggest a new-item price using known café costs. If labor, overhead, packaging or processing fees is missing, show a known-cost floor ONLY (floor, not a recommendation) and list missing inputs. Never invent missing costs or local competitor prices.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=schema.parse(raw),owner=v.ownerInputs;
  if(ctx.readEconomics){
   const {economics}=await ctx.readEconomics();
   const ownerLabor=ownerMonthlyAmount(owner?.laborCents??null,owner?.laborPeriod??null,ctx.asOf);
   const monthlyStaff=ownerLabor!==null&&
    (economics.monthlyStaff.valueCents===null||economics.monthlyStaff.status!=="actual")
     ?figure(ownerLabor,"owner","You told me"):economics.monthlyStaff;
   const month=calendarMonth(ctx.asOf);
   let units=owner?.itemsSoldPerDay!=null?
    Math.round(owner.itemsSoldPerDay*periodDays(month)):economics.monthlyUnits;
   let coverageLabel:string|null=null;
   if(units===null){
    const coverage=await resolveCoveredSalesWindow(ctx,requestedPeriod("month",ctx.asOf));
    const trend=await ctx.tools.getSalesTrend(coverage.period);
    const days=trend.available?trend.value.filter(day=>
     day.date>=coverage.period.from&&day.date<=coverage.period.to):[];
    const drinks=days.reduce((sum,day)=>sum+Math.max(0,day.drinksCount),0);
    const orders=days.reduce((sum,day)=>sum+Math.max(0,day.ordersCount),0);
    const sold=drinks>0?drinks:orders;
    if(days.length){
     units=Math.round(sold/days.length*periodDays(month));
     coverageLabel=coverage.label?coverage.label+", "+coverage.period.to.slice(0,4):
      "Recorded sales: "+coverage.period.from+"–"+coverage.period.to;
    }
   }
   const recommended=recommendFullCostPrice({
    ingredientCents:v.ingredient_cost_cents,packagingCents:v.packaging_cents,
    laborCents:monthlyStaff.valueCents,
    overheadCents:economics.monthlyBills.valueCents,units,
    feeRate:economics.feeRate,targetMargin:(v.target_margin_percent??(economics.targetMargin*100))/100
   });
   return {source:"new_item_price",period:month,coverageLabel,monthlyUnits:units,agentId:"alex",
    status:recommended.missing.length||monthlyStaff.status!=="actual"||
      economics.monthlyBills.status!=="actual"||economics.feeStatus!=="actual"?"estimate":"actual",saved:false,draft:true,
    itemName:v.item_name,category:v.category,
    recommendedPriceCents:recommended.recommendedPriceCents,
    breakEvenCents:recommended.breakEvenCents,fullCostCents:recommended.fullCostCents,
    knownCostFloorCents:recommended.knownCostFloorCents,
    knownCostFloorLabel:recommended.knownCostFloorLabel,
    pricingNote:recommended.missing.length?
     "Only a floor from known costs, not a recommendation. Missing: "+recommended.missing.join(", "):
     "Full-cost price from known inputs.",
    monthlyLabor:monthlyStaff,monthlyBills:economics.monthlyBills,
    feeRate:economics.feeRate,targetMargin:v.target_margin_percent===null?
     economics.targetMargin:v.target_margin_percent/100,
    missing:recommended.missing,
    numberEstimates:[recommended.recommendedPriceCents,recommended.breakEvenCents,
      recommended.fullCostCents,recommended.knownCostFloorCents].filter((value):value is number=>value!==null)
      .map(value=>({value,unit:"cents" as const,detail:"breakEvenSales"}))};
  }
  const ownerWindow=owner?.salesPeriod?ownerPeriod(owner.salesPeriod,ctx.asOf):null;
  const coverage=ownerWindow?{period:ownerWindow,label:null}:await resolveCoveredSalesWindow(ctx,requestedPeriod("month",ctx.asOf));
  const period=coverage.period;
  const sitePromise=ctx.tools.getSchedulingDraftInputs?.().catch(()=>undefined);
  const [labor,sales,bills,menu,site]=await Promise.all([
   ctx.tools.getLaborMetrics?.(period),ctx.tools.getProductSales?.(period),
   ctx.tools.getMonthlyBills?.(),ctx.tools.getMenuCatalog(),sitePromise
  ]);
  const missing=[...(labor?.quality.missingInputs??["laborReaderUnavailable"]),
   ...(sales?.quality.missingInputs??["productSalesReaderUnavailable"]),
   ...(bills?.quality.missingInputs??["billsReaderUnavailable"]),
   ...menu.quality.missingInputs,...(!site?.available?["locationUnavailable"]:[])];
  const laborCents=labor?.available&&labor.value.length>0&&labor.value.every(d=>
    laborKnown({wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
      laborWageStatus:d.wageStatus})&&d.loadedStaffCostCents!==null)?
    labor.value.reduce((s,d)=>s+(d.loadedStaffCostCents??0),0):null;
  const units=sales?.available?sales.value.reduce((s,d)=>s+d.units,0):null;
  const categoryUnits=sales?.available?sales.value.filter(x=>x.category===v.category).reduce((s,d)=>s+d.units,0):null;
  const laborForPeriod=laborCents??(owner?.laborCents!=null&&owner.laborPeriod?
    prorate(owner.laborCents,ownerPeriod(owner.laborPeriod,ctx.asOf)!,period):null);
  const ownerHasRent=owner?.rentCents!=null,ownerHasOtherOverhead=owner?.otherOverheadCents!=null;
  const billsComplete=Boolean(bills?.available||(ownerHasRent&&ownerHasOtherOverhead));
  // A known rent-only or other-overhead-only amount is a lower bound, not full bills.
  const billsForPeriod=bills?.available?prorate(bills.value.totalCents,calendarMonth(ctx.asOf),period):
    ownerHasRent||ownerHasOtherOverhead?prorate((owner?.rentCents??0)+(owner?.otherOverheadCents??0),
      owner?.overheadPeriod?ownerPeriod(owner.overheadPeriod,ctx.asOf)!:calendarMonth(ctx.asOf),period):null;
  const calculated=calculateNewItemPrice({
    ingredientCostCents:v.ingredient_cost_cents,packagingCents:v.packaging_cents,
    targetMarginPercent:v.target_margin_percent,labor30dCents:laborForPeriod,
    monthlyBillsCents:billsComplete?billsForPeriod:null,
    knownPartialBillsCents:billsComplete?null:billsForPeriod,
    units30d:units??(owner?.itemsSoldPerDay!=null?
      Math.round(owner.itemsSoldPerDay*periodDays(period)):null),
    menuPricesCents:menu.available?menu.value.filter(x=>x.active&&x.category===v.category)
      .flatMap(x=>x.priceCents===null?[]:[x.priceCents]):[],
  });
  const packagingMissing=v.packaging_cents===null;
  const location=site?.available?{city:site.value.city,region:site.value.region,country:site.value.countryCode}:null;
  const contribution=contributionCoverage({
    priceCents:packagingMissing?null:calculated.suggestedPriceCents,unitCostCents:v.ingredient_cost_cents,
    packagingCents:v.packaging_cents,laborCents:laborForPeriod,billsCents:billsForPeriod,
    billsComplete,days:periodDays(period),
  });
  const incompleteOwnerBills=!bills?.available&&(ownerHasRent!==ownerHasOtherOverhead);
  return {source:"new_item_price",period,coverageLabel:coverage.label,unit:"cents",...contribution,
   agentId:"alex",draft:true,saved:false,itemName:v.item_name,category:v.category,ownerInputs:owner,
   categoryUnits30d:categoryUnits,location,localCompetitorPrices:null,...calculated,
    ...(packagingMissing?{
     suggestedPriceCents:null,costPlusPriceCents:null,fullCostCents:null,
     profitPerItemCents:null,marginPercent:null,
     result:{...calculated.result,value:null}
    }:{}),
    pricingNote:packagingMissing?"Only a floor from known costs, not a recommendation. Missing: packagingCents":null,
   explain:!packagingMissing&&calculated.costPlusPriceCents!==null&&calculated.fullCostCents!==null?
    [{label:v.item_name??"New item price",inputs:[{name:"fullCost",value:money(calculated.fullCostCents)},
      {name:"targetMargin",value:percent(Math.round((100-calculated.targetMarginPercent)*100))}],
      formula:"divide",result:money(calculated.costPlusPriceCents),period,
      source:"suggest_new_item_price",provenance:v.target_margin_percent===null?"estimate":"ownerProvided"}]:[],
   missing:[...new Set([...missing,...calculated.missing,
     ...(packagingMissing?["packagingCents"]:[]),
     ...(incompleteOwnerBills?["ownerOverheadIncomplete"]:[])])],
   estimated:[...new Set([...calculated.estimated,...(labor?.quality.estimatedInputs??[]),...(bills?.quality.estimatedInputs??[])])]};
 }
}} as const;
