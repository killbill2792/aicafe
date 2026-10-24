import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {calculateNewItemPrice} from "@/lib/calc/newItemPrice";
import {requestedPeriod,prorate,periodDays,calendarMonth} from "@/lib/calc/periods";
import {ownerInputsSchema,ownerPeriod} from "./ownerInputs";
const schema=z.strictObject({
 ingredient_cost_cents:z.number().int().positive(),category:z.enum(["drink","food"]),
 packaging_cents:z.number().int().nonnegative().nullable(),
 target_margin_percent:z.number().min(0).max(60).nullable(),item_name:z.string().trim().max(120).nullable(),ownerInputs:ownerInputsSchema.nullable().optional()
});
export const newItemPriceTools={suggest_new_item_price:{
 agentId:"alex",schema,description:"Suggest a price for a new or unsaved item from its ingredient cost, the café's real labor and overhead per item sold, target margin and own menu range. Location is context only: never invent competitor or local prices.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=schema.parse(raw),owner=v.ownerInputs,
    period=(owner?.salesPeriod?ownerPeriod(owner.salesPeriod,ctx.asOf):null)??requestedPeriod("month",ctx.asOf);
  const sitePromise=ctx.tools.getSchedulingDraftInputs?.().catch(()=>undefined);
  const [labor,sales,bills,menu,site]=await Promise.all([
   ctx.tools.getLaborMetrics?.(period),ctx.tools.getProductSales?.(period),
   ctx.tools.getMonthlyBills?.(),ctx.tools.getMenuCatalog(),sitePromise
  ]);
  const missing=[...(labor?.quality.missingInputs??["laborReaderUnavailable"]),
   ...(sales?.quality.missingInputs??["productSalesReaderUnavailable"]),
   ...(bills?.quality.missingInputs??["billsReaderUnavailable"]),
   ...menu.quality.missingInputs,...(!site?.available?["locationUnavailable"]:[])];
  const laborCents=labor?.available?labor.value.reduce((s,d)=>s+d.loadedStaffCostCents,0):null;
  const units=sales?.available?sales.value.reduce((s,d)=>s+d.units,0):null;
  const categoryUnits=sales?.available?sales.value.filter(x=>x.category===v.category).reduce((s,d)=>s+d.units,0):null;
  const calculated=calculateNewItemPrice({
   ingredientCostCents:v.ingredient_cost_cents,packagingCents:v.packaging_cents,targetMarginPercent:v.target_margin_percent,
   labor30dCents:laborCents??(owner?.laborCents!=null&&owner.laborPeriod?prorate(owner.laborCents,ownerPeriod(owner.laborPeriod,ctx.asOf)!,period):null),monthlyBillsCents:bills?.available?prorate(bills.value.totalCents,calendarMonth(ctx.asOf),period):
    owner?.rentCents!=null||owner?.otherOverheadCents!=null?prorate((owner!.rentCents??0)+(owner!.otherOverheadCents??0),
      owner?.overheadPeriod?ownerPeriod(owner.overheadPeriod,ctx.asOf)!:calendarMonth(ctx.asOf),period):null,
   units30d:units??(owner?.itemsSoldPerDay!=null?Math.round(owner.itemsSoldPerDay*periodDays(period)):null),menuPricesCents:menu.available?menu.value.filter(x=>x.active&&x.category===v.category).map(x=>x.priceCents):[]
  });
  const location=site?.available?{city:site.value.city,region:site.value.region,country:site.value.countryCode}:null;
  const laborForPeriod=laborCents??(owner?.laborCents!=null&&owner.laborPeriod?
    prorate(owner.laborCents,ownerPeriod(owner.laborPeriod,ctx.asOf)!,period):null);
  const billsForPeriod=bills?.available?prorate(bills.value.totalCents,calendarMonth(ctx.asOf),period):
    owner?.rentCents!=null||owner?.otherOverheadCents!=null?prorate((owner?.rentCents??0)+(owner?.otherOverheadCents??0),
      owner?.overheadPeriod?ownerPeriod(owner.overheadPeriod,ctx.asOf)!:calendarMonth(ctx.asOf),period):null;
  const contributionCents=calculated.suggestedPriceCents-v.ingredient_cost_cents-(v.packaging_cents??0);
  const overheadPerDayCents=laborForPeriod!==null||billsForPeriod!==null?
    Math.round(((laborForPeriod??0)+(billsForPeriod??0))/periodDays(period)):null;
  const drinksPerDayToCoverOverhead=overheadPerDayCents!==null&&contributionCents>0?
    Math.ceil(overheadPerDayCents/contributionCents):null;
  return {source:"new_item_price",period,unit:"cents",contributionCents,overheadPerDayCents,drinksPerDayToCoverOverhead,
   explain:[...(owner?.laborCents!=null?[{kind:"prorate",name:"labor",value:laborForPeriod,provenance:"ownerProvided"}]:[]),
     {kind:"input",name:"unitCost",value:v.ingredient_cost_cents,provenance:"ownerProvided"},
     {kind:"input",name:"productCostRatio",value:0.30,provenance:"estimate"}],
   agentId:"alex",draft:true,saved:false,itemName:v.item_name,category:v.category,ownerInputs:owner,
   categoryUnits30d:categoryUnits,location,localCompetitorPrices:null,...calculated,
   missing:[...new Set([...missing,...calculated.missing])],
   estimated:[...new Set([...calculated.estimated,...(labor?.quality.estimatedInputs??[]),...(bills?.quality.estimatedInputs??[])])]};
 }
}} as const;
