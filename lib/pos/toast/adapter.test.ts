import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const request=vi.hoisted(()=>vi.fn());
vi.mock("./client",async(importOriginal)=>{
 const original=await importOriginal<typeof import("./client")>();
 return {...original,createToastClient:()=>({request})};
});
import {createToastAdapter,normalizeToastOrder,toastMoneyCents} from "./adapter";
import {ToastApiError} from "./client";
import type {SupabaseClient} from "@supabase/supabase-js";
const restaurant="00000000-0000-4000-8000-000000000001";
const base={guid:"00000000-0000-4000-8000-000000000002",
 closedDate:"2026-10-10T22:00:00.000+0000",checks:[{
  paymentStatus:"CLOSED",closedDate:"2026-10-10T22:00:00Z",
  amount:10,taxAmount:0.75,appliedDiscounts:[{nonTaxDiscountAmount:2}],
  selections:[{displayName:"Tea",quantity:1,price:10,voided:false,
    appliedDiscounts:[],modifiers:[],refundDetails:null}],
  payments:[{tipAmount:2,refundStatus:"NONE",refund:null}]}]};
describe("Toast read-only normalization",()=>{
 it("converts dollars to cents and rounds sub-cent values away from zero",()=>{
   expect(toastMoneyCents(11.05)).toBe(1105);
   expect(toastMoneyCents(0.29)).toBe(29);
   expect(toastMoneyCents(0.001)).toBe(0);
   expect(toastMoneyCents(1.005)).toBe(101);
   expect(toastMoneyCents(-1.005)).toBe(-101);
   expect(()=>toastMoneyCents(Number.POSITIVE_INFINITY)).toThrow(ToastApiError);
 });
 it("does not double-subtract discounts or include tax/tips in net sales",()=>{
   expect(normalizeToastOrder(base,restaurant)).toMatchObject({
     grossSalesCents:1200,discountsCents:200,refundsCents:0,netSalesCents:1000,
     taxCents:75,tipCents:200,processingFeeStatus:"missing",processingFeeCents:0});
 });
 it("rejects open and missing-close-date orders",()=>{
   expect(normalizeToastOrder({...base,checks:[{...base.checks[0],paymentStatus:"OPEN"}]},restaurant)).toBeNull();
   expect(()=>normalizeToastOrder({...base,closedDate:null},restaurant)).toThrow(ToastApiError);
 });
 it("handles an explicit selection refund once",()=>{
   const check={...base.checks[0],
    selections:[{...base.checks[0].selections[0],refundDetails:{refundAmount:3}}],
    payments:[{tipAmount:2,refundStatus:"PARTIAL",refund:{refundAmount:3,tipRefundAmount:0.5}}]};
   expect(normalizeToastOrder({...base,checks:[check]},restaurant)).toMatchObject({
     grossSalesCents:1200,discountsCents:200,refundsCents:300,netSalesCents:700,tipCents:150});
 });
});

/** Shared POS0b contract: retain permitted source data without exposing credentials
 * or changing the existing normalized wage/clock/shift consumer fields. */
describe("Toast permitted labor source-field handoff",()=>{
 const employee="00000000-0000-4000-8000-000000000003";
 const job="00000000-0000-4000-8000-000000000004";
 const shift="00000000-0000-4000-8000-000000000005";
 const entry="00000000-0000-4000-8000-000000000006";
 const breakGuid="00000000-0000-4000-8000-000000000007";
 const adapter=createToastAdapter({db:{} as SupabaseClient,
   businessId:restaurant,restaurantGuid:restaurant});
 const range={since:new Date("2026-10-10T00:00:00Z"),until:new Date("2026-10-11T00:00:00Z")};
 beforeEach(()=>request.mockReset());
 it("keeps permitted person/job identifiers, wages and contacts but strips passcodes",async()=>{
   request.mockImplementation(async(path:string)=>path.includes("/jobs")?[{
     guid:job,title:"Barista",defaultWage:19.5,wageFrequency:"HOURLY",
     tipped:true,excludeFromReporting:false,modifiedDate:"2026-10-10T09:00:00Z",
     code:"BAR",credential:"must-not-keep"
   }]:[{
     guid:employee,firstName:"Maria",lastName:"Lopez",email:"maria@example.test",
     phoneNumber:"5550101",modifiedDate:"2026-10-10T08:00:00Z",
     jobReferences:[{guid:job,externalId:"job-3",entityType:"Job"}],
     wageOverrides:[{jobReference:{guid:job},wage:20}],
     passcode:"sensitive-passcode",apiSecret:"sensitive-api-secret"
   }]);
   const employees=await adapter.fetchLaborEmployeeSources();
   const jobs=await adapter.fetchLaborJobSources();
   expect(employees).toHaveLength(1);
   expect(employees[0]).toMatchObject({employeeGuid:employee,restaurantGuid:restaurant,
     sourceFields:{firstName:"Maria",lastName:"Lopez",email:"maria@example.test",
       jobReferences:[{guid:job,externalId:"job-3"}],
       wageOverrides:[{jobReference:{guid:job},wage:20}]}});
   expect(jobs[0]).toMatchObject({jobGuid:job,sourceFields:{defaultWage:19.5,
     tipped:true,excludeFromReporting:false,code:"BAR"}});
   expect(JSON.stringify({employees,jobs})).not.toMatch(/sensitive-passcode|sensitive-api-secret|must-not-keep/);
   const existing=await adapter.fetchEmployees();
   expect(existing[0]).toMatchObject({hourlyWageCents:2000,active:true,role:"Barista"});
 });
 it("keeps time-entry source job, shift, tips and all break statuses alongside canonical fields",async()=>{
   request.mockResolvedValue([{
     guid:entry,employeeReference:{guid:employee},jobReference:{guid:job},
     shiftReference:{guid:shift,entityType:"Shift"},hourlyWage:19.5,
     inDate:"2026-10-10T09:00:00Z",outDate:"2026-10-10T17:00:00Z",
     regularHours:8,overtimeHours:0,modifiedDate:"2026-10-10T17:02:00Z",
     declaredCashTips:12.25,nonCashTips:4.5,tipsWithheld:0.5,autoClockedOut:false,
     breaks:[{guid:breakGuid,inDate:"2026-10-10T12:00:00Z",
       outDate:"2026-10-10T12:30:00Z",paid:false,missed:false,
       waived:false,breakType:{guid:job,entityType:"BreakType"},auditResponse:true},
       {guid:breakGuid,inDate:null,outDate:null,missed:true,waived:true}],
     authToken:"should-be-absent"
   }]);
   const facts=await adapter.fetchAttendanceFacts(range);
   expect(facts).toHaveLength(1);
   expect(facts[0]).toMatchObject({externalTimeEntryId:entry,
     externalEmployeeId:employee,externalLocationId:restaurant,hourlyWageCents:1950,
     providerRegularHours:8,providerOvertimeHours:0,
     sourceFields:{jobReference:{guid:job},shiftReference:{guid:shift},
       declaredCashTips:12.25,nonCashTips:4.5,tipsWithheld:0.5,
       autoClockedOut:false,breaks:[{paid:false,missed:false,auditResponse:true},
         {missed:true,waived:true}]}});
   expect(facts[0].breaks).toEqual([{start:"2026-10-10T12:00:00.000Z",
     end:"2026-10-10T12:30:00.000Z",paid:false}]);
   expect(JSON.stringify(facts)).not.toContain("should-be-absent");
 });
 it("keeps source shift schedule configuration and modified/deleted evidence",async()=>{
   request.mockResolvedValue([{
     guid:shift,employeeReference:{guid:employee},jobReference:{guid:job},
     inDate:"2026-10-10T09:00:00Z",outDate:"2026-10-10T17:00:00Z",
     modifiedDate:"2026-10-10T07:00:00Z",deletedDate:null,
     scheduleConfig:{guid:breakGuid,minBeforeClockIn:10,minAfterClockOut:15},
     providerPassword:"should-not-leak"
   }]);
   const shifts=await adapter.fetchScheduledShifts(range);
   expect(shifts).toHaveLength(1);
   expect(shifts[0]).toMatchObject({externalEmployeeId:employee,
     externalJobId:job,externalLocationId:restaurant,
     sourceFields:{modifiedDate:"2026-10-10T07:00:00Z",deletedDate:null,
       scheduleConfig:{guid:breakGuid,minBeforeClockIn:10,minAfterClockOut:15}}});
   expect(JSON.stringify(shifts)).not.toContain("should-not-leak");
   expect(shifts[0].sourceFields).not.toHaveProperty("createdDate");
 });
});
