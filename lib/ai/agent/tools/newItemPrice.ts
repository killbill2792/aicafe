import {z} from "zod";
import {laborKnown} from "@/lib/calc";
import type {AgentToolContext,AgentToolResult} from "./index";
import {calculateNewItemPrice,contributionCoverage} from "@/lib/calc/newItemPrice";
import {requestedPeriod,prorate,periodDays,calendarMonth} from "@/lib/calc/periods";
import {ownerInputsSchema,ownerPeriod,ownerMonthlyAmount} from "./ownerInputs";
import {resolveCoveredSalesWindow} from "./coverage";
import {money,percent,count,type ExplainLine} from "../explain";
import {COFFEE_SHOP_PROFILE} from "@/lib/pricing/profiles";
import {figure,recommendFullCostPrice} from "@/lib/calc/supervisorEconomics";
const schema=z.strictObject({
 ingredient_cost_cents:z.number().int().positive(),category:z.enum(["drink","food"]),
 packaging_cents:z.number().int().nonnegative().nullable(),
 target_drink_cost_percent:z.number().min(25).max(35).nullable().optional(),
 operating_margin_percent:z.number().min(0).max(30).nullable().optional(),item_name:z.string().trim().max(120).nullable(),ownerInputs:ownerInputsSchema.nullable().optional()
});
export const newItemPriceTools={suggest_new_item_price:{
 agentId:"alex",schema,description:"Suggest a drink price using the product-cost target (default 30 percent), lifting only to complete break-even. Never choose an operating margin: only pass an explicit owner-stated operating margin, capped at 30 percent, for the informational profit price. Reply with the recommended price and one short qualifier; never list components in prose. For follow-up math questions, call this tool again with the same item inputs.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=schema.parse(raw),owner=v.ownerInputs;
  if(ctx.readEconomics){
   const {economics,ownerIngredientRate}=await ctx.readEconomics();
   const ownerLabor=ownerMonthlyAmount(owner?.laborCents??null,owner?.laborPeriod??null,ctx.asOf);
   const monthlyStaff=ownerLabor!==null?figure(ownerLabor,"owner","You told me"):economics.monthlyStaff;
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
   // Only the owner's current message can authorize a different target.
   // Verify model-supplied percentages against literal owner utterances, never
   // infer a margin from the agent's proposed target or a previous answer.
   const utterances=[ctx.resolveState?.ownerText??"",...(ctx.ownerMessages??[])];
   const statedPercent=(pattern:RegExp,value:number|null|undefined)=>value!=null&&
    utterances.some(line=>{
     const match=line.match(pattern);
     return match&&Math.abs(Number(match[1])-value)<.001;
    });
   const costOwner=statedPercent(/(?:drink|product|ingredient)\\s*cost\\s*(?:target|of|is|to)?\\s*(\\d+(?:\\.\\d+)?)\\s*%/iu,v.target_drink_cost_percent);
   const marginOwner=statedPercent(/(?:operating|profit)\\s*margin\\s*(?:of|is|to)?\\s*(\\d+(?:\\.\\d+)?)\\s*%/iu,v.operating_margin_percent);
   const savedTarget=ownerIngredientRate??COFFEE_SHOP_PROFILE.targetProductCostPercent;
   const costPct=costOwner?v.target_drink_cost_percent!/100:
    Math.max(.25,Math.min(.35,savedTarget));
   const operatingMargin=marginOwner?v.operating_margin_percent!/100:economics.targetMargin;
   const sparse=economics.laborCoveredDays!=null&&economics.laborWindowDays!=null&&
    (economics.laborCoveredDays<7||economics.laborCoveredDays/economics.laborWindowDays<.5);
   const labor=sparse&&ownerLabor===null?figure(null,"missing",
    "Only "+economics.laborCoveredDays+" of "+economics.laborWindowDays+" days have payroll"):monthlyStaff;
   const missingBills=economics.missingBillCategories??[];
   const billsPartial=missingBills.length>0||economics.monthlyBills.valueCents===null;
   const recommended=recommendFullCostPrice({
    ingredientCents:v.ingredient_cost_cents,packagingCents:v.packaging_cents,
    laborCents:labor.valueCents,overheadCents:billsPartial?null:economics.monthlyBills.valueCents,
    knownOverheadCents:economics.monthlyBills.valueCents,units,
    feeRate:economics.feeRate,targetMargin:operatingMargin,targetDrinkCostPct:costPct
   });
   const source=(s:string):ExplainLine["provenance"]=>s==="owner"?"ownerProvided":
    s==="actual"?"recorded":s==="missing"?"missing":"estimate";
   const lines:ExplainLine[]=[];
   const add=(label:string,inputs:ExplainLine["inputs"],formula:ExplainLine["formula"],
    result:ExplainLine["result"],provenance:ExplainLine["provenance"],basis:string)=>{
    lines.push({label,inputs,formula,result,period:month,source:"suggest_new_item_price",provenance,basis});
   };
   const product=v.packaging_cents===null?null:v.ingredient_cost_cents+v.packaging_cents;
   if(product!==null)add("Ingredients + packaging",[
    {name:"ingredients",value:money(v.ingredient_cost_cents)},{name:"packaging",value:money(v.packaging_cents!)}],
    "sum",money(product),"ownerProvided","Your item's ingredient and packaging costs");
   if(units!==null)add("Units/month",[{name:"units",value:count(units)}],
    "sum",count(units),owner?.itemsSoldPerDay!=null?"ownerProvided":"recorded",
    coverageLabel??"Latest covered café sales");
   if(labor.valueCents!==null&&units&&recommended.laborPerUnitCents!==null)
    add("Labor/drink",[{name:"laborPerMonth",value:money(labor.valueCents)},
     {name:"units",value:count(units)}],"divide",money(Math.round(recommended.laborPerUnitCents)),
     source(labor.status),labor.reason);
   if(economics.monthlyBills.valueCents!==null&&units)
    add("Bills/drink",[{name:"billsPerMonth",value:money(economics.monthlyBills.valueCents)},
      {name:"units",value:count(units)}],"divide",
      money(Math.round(economics.monthlyBills.valueCents/units)),billsPartial?"estimate":source(economics.monthlyBills.status),
      economics.monthlyBills.reason+(missingBills.length?" (partial: "+missingBills.join(", ")+")":""));
   if(economics.feeRate!==null)add("Processing fee",[
      {name:"fee",value:percent(Math.round(economics.feeRate*10000))}],
     "sum",percent(Math.round(economics.feeRate*10000)),source(economics.feeStatus),"Café fee rate");
   if(recommended.fullCostCents!==null)add("Full loaded cost",[
      {name:"product",value:money(product!)},
      {name:"labor",value:money(Math.round(recommended.laborPerUnitCents!))},
      {name:"bills",value:money(Math.round(recommended.overheadPerUnitCents!))}],
     "sum",money(recommended.fullCostCents),"estimate","Product + labor per drink + bills per drink");
   if(product!==null&&recommended.recommendedPriceCents!==null)
    add("Recommended price",[{name:"productCost",value:money(product)},
      {name:"drinkCostTarget",value:percent(Math.round(costPct*10000))}],"divide",
      money(recommended.recommendedPriceCents),costOwner?"ownerProvided":"estimate",
      recommended.warning==="below_full_cost"?"Product-cost target lifted to break-even":"Product cost / target drink cost percentage");
   if(recommended.breakEvenCents!==null)add("Break-even",[
     {name:"fullCost",value:money(recommended.fullCostCents!)},
     {name:"afterFees",value:percent(Math.round((1-economics.feeRate!)*10000))}],
     "divide",money(recommended.breakEvenCents),"estimate","Full cost / (1 - fee)");
   if(recommended.profitPriceCents!==null)add("Profit price (informational)",[
     {name:"fullCost",value:money(recommended.fullCostCents!)},
     {name:"afterFeesAndMargin",value:percent(Math.round((1-economics.feeRate!-recommended.operatingMargin)*10000))}],
     "divide",money(recommended.profitPriceCents),marginOwner?"ownerProvided":"estimate",
     marginOwner?"You told me":"Café target operating margin");
   for(const [label,basis] of [
    ["Labor/drink",labor.reason],["Bills/drink",economics.monthlyBills.reason],
    ["Full loaded cost","Missing labor or bills"],["Break-even","Missing full costs or fee"],
    ["Profit price (informational)","Missing full costs or fee"]] as const)
     if(!lines.some(line=>line.label===label))add(label,[{name:"missing",value:{kind:"missing",reason:"none"}}],
       "sum",{kind:"missing",reason:"none"},"missing",basis);
   const numberEstimates=lines.flatMap(line=>[line.result,...line.inputs.map(i=>i.value)])
    .flatMap<{value:number;unit:"cents"|"count"|"bps";detail:"breakEvenSales"}>(value=>value.kind==="money"?[{value:value.cents,unit:"cents" as const,detail:"breakEvenSales" as const}]:
      value.kind==="count"?[{value:value.n,unit:"count" as const,detail:"breakEvenSales" as const}]:
      value.kind==="percent"?[{value:value.bps,unit:"bps" as const,detail:"breakEvenSales" as const}]:
      [] as Array<{value:number;unit:"cents"|"count"|"bps";detail:"breakEvenSales"}>);
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
    pricingNote:recommended.warning==="below_full_cost"?"Price lifted to cover full cost":
      "About "+Math.round(costPct*100)+"% drink cost",
    monthlyLabor:labor,monthlyBills:economics.monthlyBills,billsPartial,
    components:{product:{valueCents:product,source:product===null?"missing":"ownerProvided",basis:"Owner item costs"},
      labor:{valueCents:labor.valueCents,source:source(labor.status),basis:labor.reason},
      bills:{valueCents:economics.monthlyBills.valueCents,source:billsPartial?"estimate":source(economics.monthlyBills.status),basis:economics.monthlyBills.reason},
      units:{value:units,source:units===null?"missing":owner?.itemsSoldPerDay!=null?"ownerProvided":"recorded",basis:coverageLabel??"Café sales"},
      fee:{value:economics.feeRate,source:source(economics.feeStatus),basis:"Café fee rate"},
      operatingMargin:{value:recommended.operatingMargin,source:marginOwner?"ownerProvided":"estimate",basis:marginOwner?"You told me":"Saved target"},
      targetDrinkCost:{value:costPct,source:costOwner?"ownerProvided":"estimate",basis:"Product cost target"}},
    feeRate:economics.feeRate,targetMargin:recommended.operatingMargin,
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
