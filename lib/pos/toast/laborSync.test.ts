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

it("rejects malformed and backwards Toast timestamps before staging provider shifts",()=>{
 const row={externalTimeEntryId:"00000000-0000-4000-8000-000000000004",
  externalEmployeeId:"00000000-0000-4000-8000-000000000005",
  externalLocationId:p.restaurantGuid,clockIn:"2026-10-11T11:00:00Z",
  clockOut:"2026-10-11T12:00:00Z",hourlyWageCents:1500,breaks:[],
  deleted:false,sourceProvider:"toast" as const,modifiedAt:"2026-10-11T12:00:00Z"};
 expect(()=>mapToastLaborEntry(p,{...row,clockIn:"invalid"})).toThrow(ToastApiError);
 expect(()=>mapToastLaborEntry(p,{...row,clockOut:"invalid"})).toThrow(ToastApiError);
 expect(()=>mapToastLaborEntry(p,{...row,clockOut:"2026-10-11T10:00:00Z"})).toThrow(ToastApiError);
 expect(()=>mapToastLaborEntry(p,{...row,modifiedAt:"invalid"})).toThrow(ToastApiError);
 expect(mapToastLaborEntry(p,{...row,clockOut:null})).toMatchObject({clock_out:null});
 const scheduled={externalShiftId:row.externalTimeEntryId,externalEmployeeId:row.externalEmployeeId,
  externalLocationId:p.restaurantGuid,externalJobId:null,
  scheduledStart:"2026-10-11T11:00:00Z",scheduledEnd:"2026-10-11T18:00:00Z",
  deleted:false,sourceProvider:"toast" as const};
 expect(()=>mapToastScheduledShift(p,{...scheduled,scheduledStart:"invalid"})).toThrow(ToastApiError);
 expect(()=>mapToastScheduledShift(p,{...scheduled,scheduledEnd:"invalid"})).toThrow(ToastApiError);
 expect(()=>mapToastScheduledShift(p,{...scheduled,externalLocationId:row.externalEmployeeId}))
  .toThrow(ToastApiError);
});
