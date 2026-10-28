import {z} from "zod";
import {laborKnown} from "@/lib/calc";
import {laborForPeriod as sharedLaborForPeriod} from "@/lib/metrics/core/labor";
import type {AgentToolContext,AgentToolResult} from "./index";
import {calculateNewItemPrice,contributionCoverage} from "@/lib/calc/newItemPrice";
import {requestedPeriod,prorate,periodDays,calendarMonth} from "@/lib/calc/periods";
import {ownerInputsSchema,ownerPeriod,ownerMonthlyAmount} from "./ownerInputs";
import {resolveCoveredSalesWindow} from "./coverage";
import {money,percent,count,type ExplainLine} from "../explain";
import {COFFEE_SHOP_PROFILE} from "@/lib/pricing/profiles";
import {figure,recommendFullCostPrice} from "@/lib/calc/supervisorEconomics";
import {localizedMetricReason} from "@/lib/ai/agent/metricReasons";
import {ownerSpecifiedMonthlyBills,ownerSpecifiedPercent} from "./pricingOwnerEvidence";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const schema=z.strictObject({
 ingredient_cost_cents:z.number().int().positive(),category:z.enum(["drink","food"]),
 packaging_cents:z.number().int().nonnegative().nullable(),
 target_drink_cost_percent:z.number().min(25).max(35).nullable().optional(),
 operating_margin_percent:z.number().min(0).max(30).nullable().optional(),
 owner_monthly_bills_cents:z.number().int().nonnegative().nullable().optional(),item_name:z.string().trim().max(120).nullable(),ownerInputs:ownerInputsSchema.nullable().optional()
});
export const newItemPriceTools={suggest_new_item_price:{
 agentId:"alex",schema,description:"Suggest a drink price using the product-cost target (default 30 percent), lifting only to complete break-even. Never choose an operating margin: only pass an explicit owner-stated operating margin, capped at 30 percent, for the informational profit price. Reply with the recommended price and one short qualifier; never list components in prose. For follow-up math questions, call this tool again with the same item inputs.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=schema.parse(raw),owner=v.ownerInputs;
  if(ctx.readEconomics){
   const {economics,ownerIngredientRate}=await ctx.readEconomics();
   const ownerLabor=ownerMonthlyAmount(owner?.laborCents??null,owner?.laborPeriod??null,ctx.asOf);
   const savedLabor=economics.laborEvidence?sharedLaborForPeriod(
    economics.laborEvidence.dates,economics.laborEvidence.records,null,
    economics.knownMonthlyLaborExtrasCents==null?null:{
     monthlyCents:economics.knownMonthlyLaborExtrasCents,
     from:calendarMonth(ctx.asOf).from,to:calendarMonth(ctx.asOf).to}):null;
   const monthlyStaff=ownerLabor!==null?figure(ownerLabor,"owner","laborOwnerProvided"):
    savedLabor?figure(savedLabor.projectedMonthlyLaborCents,
     savedLabor.basis==="recorded"?"actual":"estimate",
     savedLabor.coveredDays<savedLabor.totalDays?"laborPartialCoverage":"laborRecorded"):
    economics.monthlyStaff;
   const month=calendarMonth(ctx.asOf);
   const openDays=economics.daysInMonth||periodDays(month);
   let units=owner?.itemsSoldPerDay!=null?
    Math.round(owner.itemsSoldPerDay*openDays):economics.monthlyUnits;
   const metrics={en,es,ar}[ctx.locale].MetricsNotes;
   const coverageDates=economics.salesCoverage;
   const pretty=(date:string)=>new Intl.DateTimeFormat(ctx.locale,{
    month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(date+"T12:00:00Z"));
   let coverageLabel:string|null=coverageDates?
    metrics.pricingCoverageScaled.replace("{from}",pretty(coverageDates.from))
      .replace("{to}",pretty(coverageDates.to)).replace("{days}",String(openDays)):null;
   if(units===null){
    const coverage=await resolveCoveredSalesWindow(ctx,requestedPeriod("month",ctx.asOf));
    const trend=await ctx.tools.getSalesTrend(coverage.period);
    const days=trend.available?trend.value.filter(day=>
     day.date>=coverage.period.from&&day.date<=coverage.period.to):[];
    const drinks=days.reduce((sum,day)=>sum+Math.max(0,day.drinksCount),0);
    const orders=days.reduce((sum,day)=>sum+Math.max(0,day.ordersCount),0);
    const sold=drinks>0?drinks:orders;
    if(days.length){
     units=Math.round(sold/days.length*openDays);
     coverageLabel=coverage.label?coverage.label+", "+coverage.period.to.slice(0,4):
      metrics.pricingCoverageRecorded.replace("{from}",coverage.period.from)
       .replace("{to}",coverage.period.to);
    }
   }
   // Only the owner's current message can authorize a different target.
   // Verify model-supplied percentages against literal owner utterances, never
   // infer a margin from the agent's proposed target or a previous answer.
   const utterances=[ctx.resolveState?.ownerText??"",...(ctx.ownerMessages??[])];
   const copy={en,es,ar}[ctx.locale].SupervisorChat;
   const costOwner=ownerSpecifiedPercent(utterances,v.target_drink_cost_percent,"drinkCost");
   const marginOwner=ownerSpecifiedPercent(utterances,v.operating_margin_percent,"operatingMargin");
   const savedTarget=ownerIngredientRate??COFFEE_SHOP_PROFILE.targetProductCostPercent;
   const costPct=costOwner?v.target_drink_cost_percent!/100:
    Math.max(.25,Math.min(.35,savedTarget));
   const operatingMargin=marginOwner?v.operating_margin_percent!/100:economics.targetMargin;
   const labor=monthlyStaff;
   const explicitBillTotal=v.owner_monthly_bills_cents!=null&&
    ownerSpecifiedMonthlyBills(utterances,v.owner_monthly_bills_cents)?
     v.owner_monthly_bills_cents:null;
   const ownerBillsComplete=owner?.rentCents!=null&&owner?.otherOverheadCents!=null;
   const ownerBills=explicitBillTotal??(ownerBillsComplete?prorate(
    owner!.rentCents!+owner!.otherOverheadCents!,
    ownerPeriod(owner?.overheadPeriod??null,ctx.asOf)??month,month):null);
   const monthlyBills=ownerBills!==null?figure(ownerBills,"owner","newItemOwnerBills"):
    economics.monthlyBills;
   const missingBills=ownerBills!==null?[]:(economics.missingBillCategories??[]);
   const billsPartial=missingBills.length>0||monthlyBills.valueCents===null;
   const plan=economics.feePlan;
   const feeRate=plan?plan.percentRate:economics.feeRate;
   const fixedPerDrink=plan?plan.fixedFeeCents/plan.drinksPerOrder:0;
   const recommended=recommendFullCostPrice({
    ingredientCents:v.ingredient_cost_cents,packagingCents:v.packaging_cents,
    laborCents:labor.valueCents,overheadCents:billsPartial?null:monthlyBills.valueCents,
    knownOverheadCents:monthlyBills.valueCents,units,
    feeRate,targetMargin:operatingMargin,targetDrinkCostPct:costPct,
    fixedFeePerDrinkCents:fixedPerDrink
   });
   const source=(s:string):ExplainLine["provenance"]=>s==="owner"?"ownerProvided":
    s==="actual"?"recorded":s==="missing"?"missing":"estimate";
   const lines:ExplainLine[]=[];
   const add=(label:string,inputs:ExplainLine["inputs"],formula:ExplainLine["formula"],
    result:ExplainLine["result"],provenance:ExplainLine["provenance"],_basis:string)=>{
    lines.push({label,inputs,formula,result,period:month,source:"suggest_new_item_price",
      provenance,basis:provenance==="ownerProvided"?"owner_provided":
      provenance==="recorded"?"recorded":provenance==="estimate"?"estimated":"missing"});
   };
   const product=v.packaging_cents===null?null:v.ingredient_cost_cents+v.packaging_cents;
   if(product!==null)add("Ingredients + packaging",[
    {name:"ingredients",value:money(v.ingredient_cost_cents)},{name:"packaging",value:money(v.packaging_cents!)}],
    "sum",money(product),"ownerProvided","Your item's ingredient and packaging costs");
   if(units!==null)add("Units/month",[{name:"units",value:count(units)}],
    "sum",count(units),owner?.itemsSoldPerDay!=null?"ownerProvided":"recorded",
    coverageLabel??metrics.pricingLatestCovered);
   if(labor.valueCents!==null&&units&&recommended.laborPerUnitCents!==null)
    add("Labor/drink",[{name:"laborPerMonth",value:money(labor.valueCents)},
     {name:"units",value:count(units)}],"divide",money(Math.round(recommended.laborPerUnitCents)),
     source(labor.status),labor.reason);
   if(monthlyBills.valueCents!==null&&units)
    add("Bills/drink",[{name:"billsPerMonth",value:money(monthlyBills.valueCents)},
      {name:"units",value:count(units)}],"divide",
      money(Math.round(monthlyBills.valueCents/units)),billsPartial?"estimate":source(monthlyBills.status),
      monthlyBills.reason+(missingBills.length?" (partial: "+missingBills.join(", ")+")":""));
   if(feeRate!==null){
    if(plan){
     const rateText=new Intl.NumberFormat(ctx.locale,{minimumFractionDigits:2,maximumFractionDigits:2})
      .format(feeRate*100)+"%";
     const perOrder=new Intl.NumberFormat(ctx.locale,{style:"currency",currency:"USD"})
      .format(plan.fixedFeeCents/100);
     const perDrink=new Intl.NumberFormat(ctx.locale,{style:"currency",currency:"USD"})
      .format(fixedPerDrink/100);
     add("Processing fee: "+rateText+" + "+perOrder+"/order (≈"+perDrink+"/drink)",
      [{name:"fixedPerOrder",value:money(Math.round(plan.fixedFeeCents))},
       {name:"drinksPerOrder",value:{kind:"text",text:new Intl.NumberFormat(ctx.locale,{
        minimumFractionDigits:2,maximumFractionDigits:2}).format(plan.drinksPerOrder)}}],
      "divide",money(Math.round(fixedPerDrink)),"ownerProvided",
      plan.processorLabel+" — saved owner-confirmed rate plan; "+plan.drinksPerOrder.toFixed(2)+" drinks/order");
    }else add("Processing fee",[{name:"fee",value:percent(Math.round(feeRate*10000))}],
      "sum",percent(Math.round(feeRate*10000)),source(economics.feeStatus),"Café effective processing fee rate");
   }
   if(plan&&feeRate!==null)add("Card percentage fee",[
     {name:"rate",value:percent(Math.round(feeRate*10000))}],
     "sum",percent(Math.round(feeRate*10000)),"ownerProvided",
     plan.processorLabel+" — saved owner-confirmed rate plan");
   if(recommended.fullCostCents!==null)add("Full loaded cost",[
      {name:"product",value:money(product!)},
      {name:"labor",value:money(Math.round(recommended.laborPerUnitCents!))},
      {name:"bills",value:money(Math.round(recommended.overheadPerUnitCents!))}],
     "sum",money(recommended.fullCostCents),"estimate","Product + labor per drink + bills per drink");
   if(recommended.fullCostCents!==null&&plan){
    add("Full cost plus fixed card fee",[
     {name:"fullCost",value:money(recommended.fullCostCents)},
     {name:"fixedPerDrink",value:money(Math.round(fixedPerDrink))}],
     "sum",money(Math.round(recommended.fullCostCents+fixedPerDrink)),
     "estimate","Full loaded cost and per-drink share of the processing fee");
   }
   if(product!==null&&recommended.recommendedPriceCents!==null)
    add("Recommended price",[{name:"productCost",value:money(product)},
      {name:"drinkCostTarget",value:percent(Math.round(costPct*10000))}],"divide",
      money(recommended.recommendedPriceCents),costOwner||ownerIngredientRate!=null?"ownerProvided":"estimate",
      recommended.warning==="below_full_cost"?"Product-cost target lifted to break-even":
      ownerIngredientRate!=null?copy.pricingSavedTarget:"Product cost / target drink cost percentage");
   if(recommended.breakEvenCents!==null)add("Break-even",[
     {name:"fullCostPlusFixed",value:money(Math.round(recommended.fullCostCents!+fixedPerDrink))},
     {name:"afterFees",value:percent(Math.round((1-feeRate!)*10000))}],
     "divide",money(recommended.breakEvenCents),"estimate",
     plan?"(Full cost + fixed fee/drink) / (1 − percentage fee)":"Full cost / (1 − fee)");
   if(recommended.profitPriceCents!==null)add("Profit price (informational)",[
     {name:"fullCostPlusFixed",value:money(Math.round(recommended.fullCostCents!+fixedPerDrink))},
     {name:"afterFeesAndMargin",value:percent(Math.round((1-feeRate!-recommended.operatingMargin)*10000))}],
     "divide",money(recommended.profitPriceCents),marginOwner?"ownerProvided":"estimate",
     marginOwner?"You told me":"Café target operating margin");
   for(const [label,basis] of [
    ["Labor/drink",labor.reason],["Bills/drink",monthlyBills.reason],
    ["Full loaded cost","Missing labor or bills"],["Break-even","Missing full costs or fee"],
    ["Profit price (informational)","Missing full costs or fee"]] as const)
     if(!lines.some(line=>line.label===label))add(label,[{name:"missing",value:{kind:"missing",reason:"none"}}],
       "sum",{kind:"missing",reason:"none"},"missing",basis);
   const numberEstimates=lines.flatMap(line=>[line.result,...line.inputs.map(i=>i.value)])
    .flatMap<{value:number;unit:"cents"|"count"|"bps"|"ratio";detail:"pricing"}>(value=>value.kind==="money"?[{value:value.cents,unit:"cents",detail:"pricing"}]:
      value.kind==="count"?[{value:value.n,unit:"count",detail:"pricing"}]:
      value.kind==="percent"?[{value:value.bps,unit:"bps",detail:"pricing"}]:[]);
   if(plan)numberEstimates.push({value:plan.drinksPerOrder,unit:"ratio",detail:"pricing"});
   const candidates=[
    ...(labor.valueCents===null?[{id:"labor-monthly",label:"Provide monthly labor",detail:"Enter monthly labor"},
      {id:"labor-unknown",label:"I don't know labor yet",detail:"Keep it incomplete"}]:[]),
    ...(billsPartial?[{id:"bills-monthly",label:"Provide monthly bills",detail:"Enter monthly costs"},
      {id:"bills-unknown",label:"Some bills are unknown",detail:"Keep it partial"}]:[])
   ];
   const missing=[...recommended.missing,...missingBills.map(category=>"monthlyBill:"+category),
    ...(candidates.length?["ownerChoiceRequired"]:[])];
   return {source:"new_item_price",period:month,coverageLabel,monthlyUnits:units,agentId:"alex",
    status:missing.length?"estimate":"actual",saved:false,draft:true,
    itemName:v.item_name,category:v.category,
    recommendedPriceCents:recommended.recommendedPriceCents,
    breakEvenCents:recommended.breakEvenCents,fullCostCents:recommended.fullCostCents,
    profitPriceCents:recommended.profitPriceCents,
    knownCostFloorCents:recommended.knownCostFloorCents,
    knownCostFloorLabel:recommended.knownCostFloorLabel,warning:recommended.warning,
    pricingNote:recommended.warning==="below_full_cost"?copy.pricingNoteBelowFullCost:
      copy.pricingNoteDrinkCost.replace("{percent}",String(Math.round(costPct*100))),
    monthlyLabor:{...labor,reasonKey:labor.reason,
      reason:localizedMetricReason(labor.reason,ctx.locale,labor.reasonParams)},
    monthlyBills:{...monthlyBills,reasonKey:monthlyBills.reason,
      reason:localizedMetricReason(monthlyBills.reason,ctx.locale,monthlyBills.reasonParams)},billsPartial,
    components:{product:{valueCents:product,source:product===null?"missing":"ownerProvided",basis:"owner_provided"},
      labor:{valueCents:labor.valueCents,source:source(labor.status),basis:labor.status==="owner"?"owner_provided":labor.status==="actual"?"recorded":"estimated"},
      bills:{valueCents:monthlyBills.valueCents,source:billsPartial?"estimate":source(monthlyBills.status),basis:monthlyBills.status==="owner"?"owner_provided":monthlyBills.status==="actual"?"recorded":"estimated"},
      units:{value:units,source:units===null?"missing":owner?.itemsSoldPerDay!=null?"ownerProvided":"recorded",basis:"recorded_sales"},
      fee:{value:feeRate,source:plan?"ownerProvided":source(economics.feeStatus),
        basis:plan?"owner_plan":"effective_fee_rate",
        fixedPerDrinkCents:fixedPerDrink,drinksPerOrderRatio:plan?.drinksPerOrder??null},
      operatingMargin:{value:recommended.operatingMargin,source:marginOwner?"ownerProvided":"estimate",basis:marginOwner?"owner_provided":"saved_target"},
      targetDrinkCost:{value:costPct,source:costOwner||ownerIngredientRate!=null?"ownerProvided":"estimate",
        basis:ownerIngredientRate!=null?"owner_provided":"product_cost_target"}},
    feeRate,targetMargin:recommended.operatingMargin,feePlan:plan??null,
    missing,explain:lines,numberEstimates,
    ...(candidates.length>0?{needsOwnerChoice:true,candidates,allowOther:true,askOwnerRequired:true}: {})};

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
    targetMarginPercent:null,labor30dCents:laborForPeriod,
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
      source:"suggest_new_item_price",provenance:"estimate"}]:[],
   missing:[...new Set([...missing,...calculated.missing,
     ...(packagingMissing?["packagingCents"]:[]),
     ...(incompleteOwnerBills?["ownerOverheadIncomplete"]:[])])],
   estimated:[...new Set([...calculated.estimated,...(labor?.quality.estimatedInputs??[]),...(bills?.quality.estimatedInputs??[])])]};
 }
}} as const;
