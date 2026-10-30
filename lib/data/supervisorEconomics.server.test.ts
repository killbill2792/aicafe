import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {cardFeesForDays} from "@/lib/metrics/core/fees";
import {laborForPeriod} from "@/lib/metrics/core/labor";
vi.mock("server-only",()=>({}));
const stubs=vi.hoisted(()=>({
 plans:vi.fn(),pricing:vi.fn(),items:vi.fn(),
}));
vi.mock("./getPricingInputs",()=>({getPricingInputs:stubs.pricing}));
vi.mock("./snapshot.server",()=>({getBusinessSnapshotFromDb:stubs.items}));
vi.mock("@/lib/pos/processingFeeEstimate.server",()=>({
 getOwnerConfirmedProcessingFeePlans:stubs.plans,
 ownerConfirmedPlanForDate:()=>null,
}));
import {readSupervisorEconomics} from "./supervisorEconomics.server";

function fixtureDb(rows:Record<string,unknown>[], options?:{employees?:Record<string,unknown>[];timecards?:Record<string,unknown>[]}):SupabaseClient{
 const collections:Record<string,unknown[]>={
  businesses:[{timezone:"America/New_York",payroll_tax_rate:.12,
   target_ingredient_cost_rate:null,owner_monthly_payroll_extras_cents:null}],
  daily_rollups:rows,locations:[{open_hours:null}],recurring_costs:[],
  employees:options?.employees??[],timecards:options?.timecards??[],
 };
 return {from(table:string){
  const data=collections[table]??[];
  const res={data,error:null};
  const q={
   select(){return q;},eq(){return q;},gte(){return q;},lte(){return q;},
   order(){return q;},limit(){return q;},range(){return q;},single(){return Promise.resolve({...res,data:data[0]??null});},
   then(ok:(result:typeof res)=>unknown){return Promise.resolve(res).then(ok);},
  };
  return q;
 }} as unknown as SupabaseClient;
}
const dates=Array.from({length:20},(_,i)=>"2026-10-"+String(i+1).padStart(2,"0"));
const rows=dates.map((date,i)=>({
 business_date:date,sales_data_status:"actual",net_sales_cents:100000,
 ingredients_cents:20000,card_fees_cents:i===0?3641:0,
 card_fees_status:i===0?"actual":"missing",staff_wages_cents:i<3?10000:null,
 staff_tax_cents:i<3?1200:null,labor_wage_status:i<3?"actual":"missing",
 staff_tax_status:i<3?"actual":"missing",drinks_count:200,orders_count:100,
}));
describe("Supervisor economics shares Money metrics/core evidence",()=>{
 it("3 of 20 imported payroll days gives partial labor and a reason, never null",async()=>{
  stubs.pricing.mockResolvedValue({items:[],business:{monthlyRevenueCents:2000000,
   monthlyVariableProductCostCents:400000,productCostsStatus:"actual",
   targetOperatingMargin:.15},menuPriceBasis:{runningKnownCents:30000,
    runningStatus:"recorded",monthlyRunningCents:30000,missingRunningCategories:[]}});
  stubs.items.mockResolvedValue({menuItems:[],breakEvenProductCosts:[]});
  stubs.plans.mockResolvedValue([{effectiveFrom:"2026-10-01",percentageBps:400}]);
  const read=await readSupervisorEconomics(fixtureDb(rows),"test-business","2026-10-21");
  const direct=laborForPeriod(read.economics.laborEvidence!.dates,read.economics.laborEvidence!.records);
  expect(read.economics.monthlyStaff.valueCents).toBe(direct.projectedMonthlyLaborCents);
  expect(read.economics.monthlyStaff.valueCents).toBeGreaterThan(0);
  expect(read.economics.monthlyStaff.reason).toBe("laborPartialCoverage");
  expect(read.economics.monthlyStaff.reasonParams).toMatchObject({covered:3,total:20});
 });
 it("fee effective rate matches shared actual > owner plan > estimated/default precedence",async()=>{
  const read=await readSupervisorEconomics(fixtureDb(rows),"test-business","2026-10-21");
  const days=rows.map(r=>({date:r.business_date,netSalesCents:r.net_sales_cents,
   cardFeesCents:r.card_fees_cents,cardFeesStatus:r.card_fees_status as "actual"|"missing",
   ordersCount:r.orders_count,salesDataStatus:"actual" as const}));
  const fees=cardFeesForDays(days,[{effectiveFrom:"2026-10-01",percentageBps:400}]);
  expect(read.economics.feeRate).toBe(fees.amountCents/2000000);
  expect(read.economics.feeStatus).toBe("estimate");
  expect(fees.actualDays).toBe(1);
 });
 it("staff wage scenarios use the rolling timecard window, not elapsed month labor coverage",async()=>{
  const rollingDays=Array.from({length:30},(_,i)=>
   new Date(Date.UTC(2026,8,2+i)).toISOString().slice(0,10));
  const history=rollingDays.map(date=>({business_date:date,sales_data_status:"actual",
   net_sales_cents:100000,ingredients_cents:20000,card_fees_cents:3000,
   card_fees_status:"actual",staff_wages_cents:date==="2026-10-01"?10000:null,
   staff_tax_cents:date==="2026-10-01"?1200:null,
   labor_wage_status:date==="2026-10-01"?"actual":"missing",
   staff_tax_status:date==="2026-10-01"?"actual":"missing",
   drinks_count:100,orders_count:50}));
  const shifts=rollingDays.slice(0,15).map(date=>({employee_id:"staff-1",
   clock_in:date+"T12:00:00Z",clock_out:date+"T20:00:00Z",
   hourly_wage_cents:1800,source_type:"toast"}));
  stubs.pricing.mockResolvedValue({items:[],business:{monthlyRevenueCents:100000,
   monthlyVariableProductCostCents:0,productCostsStatus:"missing",
   targetOperatingMargin:.15},menuPriceBasis:{runningKnownCents:0,
   monthlyRunningCents:0,runningStatus:"recorded",missingRunningCategories:[]}});
  stubs.items.mockResolvedValue({menuItems:[],breakEvenProductCosts:[]});
  stubs.plans.mockResolvedValue([]);
  const result=await readSupervisorEconomics(fixtureDb(history,{
   employees:[{id:"staff-1",display_name:"A",role:"barista",default_hourly_wage_cents:1800}],
   timecards:shifts}),"test-business","2026-10-02");
  expect(result.economics.laborWindowDays).toBe(1);
  expect(result.staff[0].weeklyHours).toBe(28);
 });
});
