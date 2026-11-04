import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {resolveEntity,choicePayload,ownerNamedTarget,ownerChose} from "../resolve";
import {simulateEconomics,type ScenarioDelta} from "@/lib/calc/supervisorEconomics";
import {money,count,percent,type ExplainLine} from "../explain";
const schema=z.strictObject({
 kind:z.enum(["bill","item_price","item_cost","shift","staff_wage","drinks","margin"]),
 itemId:z.uuid().nullable(),
 staffId:z.uuid().nullable(),
 role:z.string().max(80).nullable(),
 deltaCents:z.number().int().safe().nullable(),
 newValueCents:z.number().int().safe().nullable(),
 changePercent:z.number().min(-100).max(1000).nullable(),
 hours:z.number().min(-24).max(24).nullable(),
 shiftsPerWeek:z.number().int().min(1).max(7).nullable(),
 targetMargin:z.number().min(0).max(.8).nullable()
});
export const scenarioTools={simulate_scenario:{
 agentId:"leo",schema,
 description:"For WHAT IF questions, always call this before answering. It is read-only: no proposal/card or POS write. Supply changes in integer cents: +50000 for $500 rent, +10 for ten cents; itemId must come from get_menu_items, staffId from get_team. For ambiguous names ask_owner before simulating. The tool returns before, after, difference and estimated evidence. Only call a propose_* tool after the owner later says do it.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=schema.parse(raw);
  if(!ctx.readEconomics)return {source:"scenario",period:null,missing:["economicsReaderUnavailable"]};
  const read=await ctx.readEconomics(),economics=read.economics;
  let delta:ScenarioDelta;
  if(v.kind==="bill"){
   if(v.deltaCents===null)return {source:"scenario",period:null,missing:["billChangeMissing"]};
   delta={kind:"bill",monthlyChangeCents:v.deltaCents};
  }else if(v.kind==="drinks"){
   if(v.changePercent===null)return {source:"scenario",period:null,missing:["volumeChangeMissing"]};
   delta={kind:"drinks",changePercent:v.changePercent};
  }else if(v.kind==="margin"){
   if(v.targetMargin===null)return {source:"scenario",period:null,missing:["targetMarginMissing"]};
   delta={kind:"margin",targetMargin:v.targetMargin};
  }else if(v.kind==="item_price"||v.kind==="item_cost"){
   if(!v.itemId)return {source:"scenario",period:null,missing:["itemNotChosen"]};
   const catalog=await ctx.tools.getMenuCatalog();
   if(!catalog.available)return {source:"scenario",period:null,missing:catalog.quality.missingInputs};
   const products=catalog.value.filter(product=>product.active);
   const product=products.find(row=>row.id===v.itemId);
   if(!product)return {source:"scenario",period:null,missing:["itemNotFound"]};
   const choice=resolveEntity("product",product.name,products,{idOf:p=>p.id,nameOf:p=>p.name,
    describe:p=>p.category+" · "+(p.priceCents===null?"price unavailable":(p.priceCents/100).toFixed(2))});
   if(choice.status==="ambiguous"&&!ownerChose(ctx.resolveState,product.id))
    return {...choicePayload(choice,"scenario",null),agentId:"leo"};
   if(!ownerNamedTarget(ctx.resolveState,product.id,product.name))
    return {source:"scenario",period:null,missing:["itemNotConfirmed"]};
   const item=read.items.find(row=>row.id===product.id);
   if(!item)return {source:"scenario",period:null,missing:["itemPricingUnavailable"]};
   const date=new Date(ctx.asOf+"T12:00:00Z");
   date.setUTCDate(date.getUTCDate()-6);
   const from=date.toISOString().slice(0,10);
   const observed=await ctx.tools.getProductSales?.({from,to:ctx.asOf});
   if(!observed?.available&&item.unitsSoldInWindow<=0)
    return {source:"scenario",period:null,missing:["weeklyItemSalesUnavailable"]};
   const weeklyUnits=observed?.available?observed.value.find(row=>row.id===product.id)?.units??0:
    Math.round(item.unitsSoldInWindow*7/90);
   if(v.kind==="item_price"){
    const newPrice=v.newValueCents??(v.deltaCents===null?null:item.currentPriceCents+v.deltaCents);
    if(newPrice===null||newPrice<=0)return {source:"scenario",period:null,missing:["newPriceMissing"]};
    delta={kind:"price",itemId:product.id,oldPriceCents:item.currentPriceCents,
     newPriceCents:newPrice,weeklyUnits,unitCostCents:item.productCostStatus==="READY"?item.productCostCents:null};
   }else{
    const cost=item.productCostStatus==="READY"?item.productCostCents:null;
    if(cost===null)return {source:"scenario",period:null,missing:["itemCostMissing"]};
    const newCost=v.newValueCents??(v.deltaCents===null?null:cost+v.deltaCents);
    if(newCost===null||newCost<0)return {source:"scenario",period:null,missing:["newItemCostMissing"]};
    delta={kind:"item_cost",itemId:product.id,oldCostCents:cost,newCostCents:newCost,
      weeklyUnits,currentPriceCents:item.currentPriceCents};
   }
  }else{
   const candidates=read.staff.filter(s=>v.staffId?s.id===v.staffId:
    v.role?s.role?.toLocaleLowerCase()===v.role.toLocaleLowerCase():false);
   if(candidates.length>1)return {source:"scenario",period:null,missing:["staffChoiceRequired"],
    needsOwnerChoice:true,candidates:candidates.slice(0,12).map(row=>({
      id:row.id,label:row.displayName,detail:row.role??"Staff"
    }))};
   if(candidates.length!==1)return {source:"scenario",period:null,missing:["staffNotFound"]};
   const employee=candidates[0];
   if(!ownerNamedTarget(ctx.resolveState,employee.id,employee.displayName)&&
      !ownerNamedTarget(ctx.resolveState,employee.id,employee.role??""))
      return {source:"scenario",period:null,missing:["staffNotConfirmed"]};
   if(employee.wageCents===null)return {source:"scenario",period:null,missing:["staffWageMissing"]};
   if(v.kind==="shift"){
    if(v.hours===null)return {source:"scenario",period:null,missing:["shiftHoursMissing"]};
    delta={kind:"shift",hoursChange:v.hours,shiftsPerWeek:v.shiftsPerWeek??1,
      wageCents:employee.wageCents,payrollTaxRate:economics.payrollTaxRate??.12};
   }else{
    if(v.deltaCents===null||employee.weeklyHours===null)
     return {source:"scenario",period:null,missing:["wageDeltaOrWeeklyHoursMissing"]};
    delta={kind:"wage",weeklyHours:employee.weeklyHours,oldWageCents:employee.wageCents,
     newWageCents:employee.wageCents+v.deltaCents,payrollTaxRate:economics.payrollTaxRate??.12};
   }
  }
  const result=simulateEconomics(economics,delta);
  // Explain the exact canonical what-if result; never recompute the business metric.
  const explain:ExplainLine[]=[];
  const add=(label:string,inputs:ExplainLine["inputs"],formula:ExplainLine["formula"],
    value:number|null,basis:string)=>{
    if(value===null||!Number.isSafeInteger(value))return;
    explain.push({label,inputs,formula,result:money(value),period:null,
      source:"scenario",provenance:"estimate",basis});
  };
  if(delta.kind==="price"){
    const fee=economics.feeRate;
    if(fee!==null&&result.weeklyChangeCents!==null){
      add("Weekly price difference",[
        {name:"New price",value:money(delta.newPriceCents)},
        {name:"Old price",value:money(delta.oldPriceCents)}],
        "subtract",delta.newPriceCents-delta.oldPriceCents,"projected");
      add("Weekly gain after processing fees",[
        {name:"New price",value:money(delta.newPriceCents)},
        {name:"Old price",value:money(delta.oldPriceCents)},
        {name:"Weekly units",value:count(delta.weeklyUnits)},
        {name:"Processing fee rate",value:percent(Math.round(fee*10000))}],
        "multiply",result.weeklyChangeCents,"projected");
    }
  }else if(delta.kind==="item_cost"){
    add("Weekly item cost effect",[
      {name:"Old cost",value:money(delta.oldCostCents)},
      {name:"New cost",value:money(delta.newCostCents)},
      {name:"Weekly units",value:count(delta.weeklyUnits)}],
      "multiply",result.weeklyChangeCents,"projected");
  }else if(delta.kind==="bill"){
    add("Monthly bill effect",[{name:"Monthly bill change",value:money(delta.monthlyChangeCents)}],
      "subtract",result.difference.monthlyProfitCents,"projected");
  }else if(delta.kind==="shift"||delta.kind==="wage"){
    add("Weekly staffing effect",delta.kind==="shift"?[
      {name:"Hours change",value:count(delta.hoursChange)},
      {name:"Shifts per week",value:count(delta.shiftsPerWeek)},
      {name:"Hourly wage",value:money(delta.wageCents)},
      {name:"Payroll tax",value:percent(Math.round(delta.payrollTaxRate*10000))}]:[
      {name:"Weekly hours",value:count(delta.weeklyHours)},
      {name:"Old wage",value:money(delta.oldWageCents)},
      {name:"New wage",value:money(delta.newWageCents)},
      {name:"Payroll tax",value:percent(Math.round(delta.payrollTaxRate*10000))}],
      "multiply",result.weeklyChangeCents,"projected");
  }else if(delta.kind==="drinks"){
    if(economics.monthlyRevenue.valueCents!==null&&economics.ingredientRate!==null&&economics.feeRate!==null){
      add("Monthly sales-volume effect",[
        {name:"Monthly revenue",value:money(economics.monthlyRevenue.valueCents)},
        {name:"Volume change",value:percent(Math.round(delta.changePercent*100))},
        {name:"Ingredient rate",value:percent(Math.round(economics.ingredientRate*10000))},
        {name:"Processing fee rate",value:percent(Math.round(economics.feeRate*10000))}],
        "multiply",result.difference.monthlyProfitCents,"projected");
    }
  }
  if(result.difference.monthlyProfitCents!==null&&result.weeklyChangeCents!==null&&
      (delta.kind==="price"||delta.kind==="item_cost"||delta.kind==="shift"||delta.kind==="wage")){
    add("Monthly equivalent of weekly change",[
      {name:"Weekly change",value:money(result.weeklyChangeCents)},
      {name:"Days in month",value:count(economics.daysInMonth)},
      {name:"Days in week",value:count(7)}],
      "prorate",result.difference.monthlyProfitCents,"projected");
  }
  const observed=[result.before.monthlyProfitCents,
   result.before.monthlyTargetSalesCents,result.after.monthlyTargetSalesCents,result.before.monthlyBreakEvenCents,
   result.after.monthlyProfitCents,result.after.monthlyBreakEvenCents,
   result.difference.monthlyProfitCents,result.difference.monthlyBreakEvenCents,
   result.weeklyChangeCents,result.before.itemMarginCents,result.after.itemMarginCents];
  return {source:"scenario",period:null,agentId:"leo",status:"estimate",
   input:delta,...result,explain,numberEstimates:observed.filter((value):value is number=>value!==null)
    .map(value=>({value,unit:"cents" as const,detail:"scenario"})),
   ...(result.after.drinksPerDay!==null?{numberEstimatesCounts:[result.after.drinksPerDay]}:{})};
 }
}} as const;
