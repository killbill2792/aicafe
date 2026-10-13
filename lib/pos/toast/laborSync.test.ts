import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {mapToastLaborEntry,mapToastScheduledShift} from "./laborSync";
import {ToastApiError} from "./client";
const p={businessId:"00000000-0000-4000-8000-000000000001",
 locationId:"00000000-0000-4000-8000-000000000002",
 restaurantGuid:"00000000-0000-4000-8000-000000000003"};
it("stores missing Toast wages as null and never invents clock out or payroll expense",()=>{
 const row=mapToastLaborEntry(p,{externalTimeEntryId:"00000000-0000-4000-8000-000000000004",
  externalEmployeeId:"00000000-0000-4000-8000-000000000005",
  externalLocationId:p.restaurantGuid,clockIn:"2026-10-11T11:00:00Z",
  clockOut:null,hourlyWageCents:null,breaks:[],deleted:false,sourceProvider:"toast"});
 expect(row).toMatchObject({hourly_wage_cents:null,wage_status:"missing",clock_out:null});
});
it("keeps scheduled shifts distinct from actual attendance",()=>{
 const row=mapToastScheduledShift(p,{externalShiftId:"00000000-0000-4000-8000-000000000004",
  externalEmployeeId:"00000000-0000-4000-8000-000000000005",
  externalLocationId:p.restaurantGuid,externalJobId:null,scheduledStart:"2026-10-11T11:00:00Z",
  scheduledEnd:"2026-10-11T18:00:00Z",deleted:true,sourceProvider:"toast"});
 expect(row).toMatchObject({provider:"toast",deleted:true,external_job_id:null});
 expect(()=>mapToastScheduledShift(p,{...{
  externalShiftId:"00000000-0000-4000-8000-000000000004",
  externalEmployeeId:"00000000-0000-4000-8000-000000000005",
  externalLocationId:p.restaurantGuid,externalJobId:null,scheduledStart:"2026-10-11T20:00:00Z",
  scheduledEnd:"2026-10-11T18:00:00Z",deleted:false,sourceProvider:"toast" as const}}))
 .toThrow(ToastApiError);
});
