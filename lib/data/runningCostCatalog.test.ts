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
  expect(lines.find(r=>r.categoryCode==="other")).toMatchObject({amountCents:71000,recordedExpenseCents:51000,
   recurringEstimateCents:20000,amountSource:"mixed",actualTodayCents:51000,isEstimate:true});
 });
 it("preserves unfamiliar categories even when omitted from recovery order",()=>{
  const lines=runningCostLinesForMonth({...context,order:["rent"],expenses:[
   {id:"custom",category_code:"property_tax",amount_cents:32000,status:"actual",spent_on:"2026-11-15"},
  ]});
  expect(lines.find(r=>String(r.categoryCode)==="property_tax")).toMatchObject({amountCents:32000,recordedExpenseCents:32000});
 });
});
