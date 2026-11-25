import {describe,it,expect} from "vitest";
import {runningCostLinesForMonth} from "./runningCostCatalog";

describe("obligation-level monthly cost evidence",()=>{
 const bills=[
  {id:"rent",category_code:"other",amount_cents:50000,frequency:"monthly",is_estimate:false,active_from:"2026-01-01",active_to:null},
  {id:"security",category_code:"other",amount_cents:20000,frequency:"monthly",is_estimate:false,active_from:"2026-01-01",active_to:null},
 ];
 const context={from:"2026-11-01",to:"2026-11-30",today:"2026-11-15",historical:false,recurring:bills};
 it("does not suppress a second obligation in the same category or count a linked payment twice",()=>{
  const lines=runningCostLinesForMonth({...context,order:["rent"],expenses:[
   {id:"paid",category_code:"other",amount_cents:49000,status:"actual",spent_on:"2026-11-15",recurring_cost_id:"rent"},
   {id:"repair",category_code:"other",amount_cents:2000,status:"actual",spent_on:"2026-11-15"},
  ]});
  expect(lines.find(r=>r.categoryCode==="other")).toMatchObject({amountCents:70000,recordedExpenseCents:51000,
   recurringEstimateCents:19000,possibleAdditionalForecastCents:2000,forecastOverlapUncertain:true,amountSource:"mixed",actualTodayCents:51000,isEstimate:true});
 });
 it("preserves separate labels, source dates, recurring amounts and partial payments without assuming behaviour",()=>{
  const lines=runningCostLinesForMonth({...context,recurring:[{
    id:"weekly",category_code:"other",label:"Waste collection",frequency:"weekly",amount_cents:3000,
    source:"owner",due_day:4,active_from:"2026-10-01",active_to:null,is_estimate:false
  }],expenses:[{id:"payment",category_code:"other",custom_label:"Waste week one",source:"receipt",amount_cents:3000,
    status:"actual",spent_on:"2026-11-06",recurring_cost_id:"weekly"}]});
  expect(lines.find(r=>r.categoryCode==="other")).toMatchObject({amountCents:13000,recordedExpenseCents:3000,
   recurringEstimateCents:10000,expenseEvidence:[
    {kind:"expense",id:"payment",label:"Waste week one",status:"actual",source:"receipt",date:"2026-11-06"},
    {kind:"recurring",id:"weekly",label:"Waste collection",frequency:"weekly",amountCents:3000,
     monthlyEquivalentCents:13000,linkedRecordedCents:3000,remainingForecastCents:10000,costBehaviour:"unknown"}
   ]});
 });
 it("does not count future receipts or expired obligations; keeps future active commitments in a forecast",()=>{
  const lines=runningCostLinesForMonth({...context,recurring:[
   {...bills[0],active_to:"2026-10-31"},{...bills[1],active_from:"2026-11-20"}],
   expenses:[{id:"future",category_code:"other",amount_cents:20000,status:"actual",spent_on:"2026-11-21",recurring_cost_id:"security"}]});
  expect(lines.find(r=>r.categoryCode==="other")).toMatchObject({recordedExpenseCents:0,recurringEstimateCents:20000,
    expenseEvidence:[{kind:"recurring",id:"security"}],isEstimate:true});
 });
 it("preserves unfamiliar categories even when omitted from recovery order",()=>{
  const lines=runningCostLinesForMonth({...context,order:["rent"],expenses:[
   {id:"custom",category_code:"property_tax",amount_cents:32000,status:"actual",spent_on:"2026-11-15"},
  ]});
  expect(lines.find(r=>String(r.categoryCode)==="property_tax")).toMatchObject({amountCents:32000,recordedExpenseCents:32000});
 });
});
