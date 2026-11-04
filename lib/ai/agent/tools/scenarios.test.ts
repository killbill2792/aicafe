import {describe,it,expect} from "vitest";
import {scenarioTools} from "./scenarios";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type {AgentToolContext} from "./index";
import type {ExplainLine} from "../explain";
import {explainLineSchema} from "../explain";
import {localizedLabel} from "@/components/home/HowIGotThis";

const base:Economics={
 monthlyBills:figure(746700,"actual","Bills"),
 monthlyStaff:figure(1300000,"owner","Owner confirmed"),
 monthlyRevenue:figure(3000000,"estimate","Projected"),
 ingredientRate:.30,feeRate:.029,ingredientStatus:"owner",feeStatus:"estimate",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,
 targetMargin:.15,missingDays:[],payrollTaxRate:.18,
};
const id="33333333-3333-4333-8333-333333333333";
const drink="22222222-2222-4222-8222-222222222222";
const tools={
 getProfitability:async()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getSalesTrend:async()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getMenuCatalog:async()=>({available:true as const,value:[{id:drink,name:"Latte",category:"drink",active:true,priceCents:2000}],
  quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getProductSales:async()=>({available:true as const,value:[{id:drink,name:"Latte",category:"drink" as const,units:100}],quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
};
const read=async()=>({economics:base,ownerMonthlyPayrollExtrasCents:1300000,ownerIngredientRate:.30,
 staff:[{id,displayName:"Maria",role:"barista",wageCents:2000,weeklyHours:28}],
 items:[{id:drink,name:"Latte",category:"ESPRESSO_DRINK" as const,currentPriceCents:2000,
  productCostCents:600,productCostStatus:"READY" as const,unitsSoldInWindow:1000}]
});
const context=()=>({asOf:"2026-10-26",locale:"en" as const,tools,readEconomics:read} as unknown as AgentToolContext);
const raw={kind:"bill",itemId:null,staffId:null,role:null,deltaCents:50000,newValueCents:null,
 changePercent:null,hours:null,shiftsPerWeek:null,targetMargin:null};
describe("scoped read-only supervisor scenario tool",()=>{
 it("returns a 500-dollar rent increase without creating any approval card",async()=>{
  const result=await scenarioTools.simulate_scenario.execute(raw,context());
  expect(result).toMatchObject({source:"scenario",status:"estimate",weeklyChangeCents:0,
    difference:{monthlyProfitCents:-50000}});
  expect(result).not.toHaveProperty("proposalId");
 });
 it("uses saved payroll taxes for a six-hour shorter shift",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"shift",
    staffId:id,deltaCents:null,hours:-6,shiftsPerWeek:1},context());
  expect(result.weeklyChangeCents).toBe(Math.round(6*2000*1.18));
 });
 it("rejects missing staff wage instead of pretending a zero wage",async()=>{
  const original=await read();
  const ctx={...context(),readEconomics:async()=>({...original,
    staff:[{...original.staff[0],wageCents:null}]})};
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"shift",
    staffId:id,hours:-6,deltaCents:null},ctx);
  expect(result.missing).toContain("staffWageMissing");
 });
 it("computes 10-cent latte gain against evidenced weekly units",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"item_price",
    itemId:drink,deltaCents:10},context());
  expect(result.weeklyChangeCents).toBe(971);
  const lines=result.explain as Array<{label:string;source:string;result:{kind:string;cents:number};inputs:Array<{name:string}>}>;
  const weekly=lines.find(line=>line.label==="Weekly gain after processing fees") as typeof lines[number];
  expect(weekly.source).toBe("scenario");
  expect(weekly.result).toEqual({kind:"money",cents:971});
  expect((weekly as unknown as ExplainLine).formula).toBe("scenarioPrice");
  expect(weekly.inputs.map(input=>input.name)).toEqual([
    "New price","Old price","Weekly units","Processing fee rate"]);
  const monthly=lines.find(line=>line.label==="Monthly equivalent of weekly change") as typeof lines[number]&{label:string};
  expect(monthly.inputs.map(input=>input.name)).toEqual(["Weekly change","Days in month","Days in week"]);
  expect(result).not.toHaveProperty("proposalId");
 });
 it("returns target-margin goal, not an invented changed break-even",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"margin",
    deltaCents:null,targetMargin:.20},context());
  const before=result.before as {monthlyTargetSalesCents:number;monthlyBreakEvenCents:number};
  const after=result.after as {monthlyTargetSalesCents:number;monthlyBreakEvenCents:number};
  expect(after.monthlyTargetSalesCents).toBeGreaterThan(before.monthlyTargetSalesCents);
  expect(after.monthlyBreakEvenCents).toBe(before.monthlyBreakEvenCents);
 });
 it("does not give a fabricated full-profit number with an unknown fee",async()=>{
  const original=await read();
  const result=await scenarioTools.simulate_scenario.execute(raw,{
   ...context(),readEconomics:async()=>({...original,
    economics:{...base,feeRate:null,feeStatus:"missing" as const}})
  });
  expect(result.before).toMatchObject({monthlyProfitCents:null,monthlyBreakEvenCents:null});
 });
 it("every published scenario equation re-evaluates to its typed integer-cent result",async()=>{
  const cases=[
    raw,
    {...raw,kind:"item_price",itemId:drink,deltaCents:10},
    {...raw,kind:"item_cost",itemId:drink,deltaCents:10},
    {...raw,kind:"shift",staffId:id,deltaCents:null,hours:-6,shiftsPerWeek:2},
    {...raw,kind:"staff_wage",staffId:id,deltaCents:100},
    {...raw,kind:"drinks",deltaCents:null,changePercent:10},
  ];
  const numeric=(v:ExplainLine["inputs"][number]["value"])=>{
    if(v.kind==="money")return v.cents;
    if(v.kind==="count")return v.n;
    if(v.kind==="percent")return v.bps/10000;
    throw new Error("unexpected nonnumeric scenario input");
  };
  const evaluate=(line:ExplainLine):number=>{
    const [a,b,c,d]=line.inputs.map(input=>numeric(input.value));
    switch(line.formula){
      case "subtract":return a-b;
      case "scenarioNegate":return -a;
      case "scenarioPrice":return Math.round((a-b)*c*(1-d));
      case "scenarioCost":return Math.round((a-b)*c);
      case "scenarioShift":return -Math.round(a*b*c*(1+d));
      case "scenarioWage":return -Math.round(a*(c-b)*(1+d));
      case "scenarioVolume":return Math.round(a*b*(1-c-d));
      case "scenarioProrate":return Math.round(a*b/c);
      default:throw new Error("unsupported scenario equation "+line.formula);
    }
  };
  const seen=new Set<string>();
  for(const item of cases){
    const result=await scenarioTools.simulate_scenario.execute(item,context());
    const lines=result.explain as ExplainLine[];
    expect(lines.length).toBeGreaterThan(0);
    for(const line of lines){
      expect(explainLineSchema.safeParse(line).success).toBe(true);
      expect(line.result.kind).toBe("money");
      if(line.result.kind!=="money")throw new Error("non-money result");
      expect(evaluate(line)).toBe(line.result.cents);
      // Every owner-facing string emitted by the actual scenario tool must have
      // a locale-specific counterpart; never fall back to its English literal.
      for(const name of [line.label,...line.inputs.map(input=>input.name)])
        for(const locale of ["es","ar"] as const){
          expect(localizedLabel(name,locale)).not.toBe(name);
          expect(localizedLabel(name,locale).trim().length).toBeGreaterThan(0);
        }
      seen.add(line.formula);
    }
  }
  expect([...seen].sort()).toEqual(["scenarioCost","scenarioNegate","scenarioPrice",
    "scenarioProrate","scenarioShift","scenarioVolume","scenarioWage","subtract"].sort());
 });

});
