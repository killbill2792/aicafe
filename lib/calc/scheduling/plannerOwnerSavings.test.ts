import {describe,it,expect} from "vitest";
import {modelUnpaidOwnerWhatIf,HYPOTHETICAL_OWNER_ID} from "./plannerOwnerSavings";
import type {PlannerInput,PlannerEmployee} from "./plannerTypes";
const available=(day:number)=>({day_of_week:day,start_local:"09:00",
 end_local:"11:00",overnight:false,effective_from:"2026-01-01",
 effective_to:null,confirmation:"owner_confirmed" as const});
const paid:PlannerEmployee={id:"paid",displayName:"Barista",active:true,
 recurring:[available(1)],exceptions:[],qualifications:[],
 wage:{wage_period:"hour",wage_amount_cents:2000,default_hourly_wage_cents:null},
 provenance:"known_paid"};
const input:PlannerInput={horizonStart:"2026-10-12",slotMinutes:60,
 locations:[{id:"main",timezone:"America/Los_Angeles"}],employees:[paid],
 coverage:[{id:"service",locationId:"main",dayOfWeek:1,
  start_local:"09:00",end_local:"11:00",overnight:false,
  minHeadcount:1,priority:"required"}]};
describe("Olivia read-only unpaid owner savings",()=>{
 it("shows the owner's shift and the modeled paid wage replaced, with no write",()=>{
  const result=modelUnpaidOwnerWhatIf(input);
  expect(result.completeCoverage).toBe(true);
  expect(result.baselineCashWagesCents).toBe(4000);
  expect(result.withOwnerCashWagesCents).toBe(0);
  expect(result.savingsCents).toBe(4000);
  expect(result.replacementRows).toMatchObject([{paidMinutes:120,
   baselineWorker:"Barista",baselineHourlyWageCents:2000}]);
  expect(result.ownerMinutes).toBe(120);
  expect(input.employees).toEqual([paid]);
 });
 it("never pretends the owner has required qualifications",()=>{
  const restricted={...input,coverage:[{...input.coverage[0],
   qualificationCode:"certified-barista"}],
   employees:[{...paid,qualifications:[{code:"certified-barista",
    validFrom:"2026-01-01",confirmed:true}]}]};
  const result=modelUnpaidOwnerWhatIf(restricted);
  expect(result.replacementRows).toEqual([]);
  expect(result.savingsCents).toBe(0);
 });
});