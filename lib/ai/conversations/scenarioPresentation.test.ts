import {describe,it,expect} from "vitest";
import {figure,simulateEconomics,type Economics,type ScenarioDelta} from "@/lib/calc/supervisorEconomics";
import {captureScenarioBasis,evaluateScenarioEditor,scenarioEditorSchema} from "./scenarioPresentation";
const economics:Economics={monthlyBills:figure(100000,"actual","Bill"),monthlyStaff:figure(200000,"actual","Staff"),
 monthlyRevenue:figure(900000,"actual","Sales"),ingredientRate:.25,feeRate:.03,ingredientStatus:"actual",feeStatus:"actual",
 averagePriceCents:500,monthlyUnits:1800,daysInMonth:30,targetMargin:.2,missingDays:[]};
describe("canonical scenario editor",()=>{
 const cases:{delta:ScenarioDelta;changes:Record<string,string>;edited:ScenarioDelta}[]=[
 {delta:{kind:"price",itemId:"latte",oldPriceCents:500,newPriceCents:550,weeklyUnits:50,unitCostCents:150},
 changes:{newPriceCents:"6",weeklyUnits:"60"},edited:{kind:"price",itemId:"latte",oldPriceCents:500,newPriceCents:600,weeklyUnits:60,unitCostCents:150}},
 {delta:{kind:"shift",hoursChange:-1,shiftsPerWeek:5,wageCents:2000,payrollTaxRate:.12},changes:{hoursChange:"-2"},edited:{kind:"shift",hoursChange:-2,shiftsPerWeek:5,wageCents:2000,payrollTaxRate:.12}},
 {delta:{kind:"bill",monthlyChangeCents:1000},changes:{monthlyChangeCents:"20"},edited:{kind:"bill",monthlyChangeCents:2000}},
 {delta:{kind:"drinks",changePercent:5},changes:{changePercent:"10"},edited:{kind:"drinks",changePercent:10}},
 ];
 for(const {delta,changes,edited} of cases)it("reuses exact saved simulator "+delta.kind,()=>{
  const seed=captureScenarioBasis(economics,delta);
  expect(seed).not.toBeNull();expect(JSON.stringify(seed)).not.toContain("itemId");
  const editor=scenarioEditorSchema.parse({...seed,metric:"monthlyProfitCents"});
  const expected=simulateEconomics(economics,edited),original=simulateEconomics(economics,delta);
  expect(evaluateScenarioEditor(editor)).toEqual({beforeCents:original.before.monthlyProfitCents,afterCents:original.after.monthlyProfitCents});
  expect(evaluateScenarioEditor(editor,changes)).toEqual({beforeCents:expected.before.monthlyProfitCents,afterCents:expected.after.monthlyProfitCents});
  expect(evaluateScenarioEditor(editor,{...changes,[Object.keys(changes)[0]]:"invalid"})).toBeNull();
 });
 it("does not replace observed-day break-even with an approximate client engine",()=>{
  expect(scenarioEditorSchema.safeParse({...captureScenarioBasis(economics,cases[0].delta),metric:"monthlyBreakEvenCents"}).success).toBe(false);
 });
});
