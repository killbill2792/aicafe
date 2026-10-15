import { describe, expect, it } from "vitest";
import { availabilityBatchSchema } from "./availabilityBatchSchemas";

const employeeId = "10000000-0000-4000-8000-000000000001";
const locationId = "10000000-0000-4000-8000-000000000002";
const requestKey = "10000000-0000-4000-8000-000000000003";
const baseline = {
  kind: "availability_rule" as const,
  employeeId, locationId: null,
  requestKey,
  scope: { effective_from: "2026-10-14", effective_to: null },
  expected: [] as Array<{ id: string; revision: number }>,
  desired: [{
    data: {
      employee_id: employeeId, location_id: null,
      day_of_week: 3, start_local: "22:00", end_local: "02:00",
      overnight: true, effective_from: "2026-10-14", effective_to: null,
      source: "owner_direct" as const, confirmation: "unconfirmed" as const,
    },
  }],
};

describe("Olivia PR1B complete-scope batch contract", () => {
  it("accepts midnight crossing in minute-local clock times", () => {
    expect(availabilityBatchSchema.safeParse(baseline).success).toBe(true);
  });
  it("rejects forged business and actor identity and mismatched employees", () => {
    expect(availabilityBatchSchema.safeParse({...baseline,business_id:employeeId}).success).toBe(false);
    expect(availabilityBatchSchema.safeParse({...baseline,desired:[
      {data:{...baseline.desired[0].data,employee_id:locationId}},
    ]}).success).toBe(false);
    expect(availabilityBatchSchema.safeParse({...baseline,locationId,desired:baseline.desired}).success).toBe(false);
  });
  it("rejects invalid time, duplicate records, stale manifest omission and scope mutation", () => {
    for(const invalid of ["24:00","09:00:01","07:99","9:00"]){
      expect(availabilityBatchSchema.safeParse({...baseline,desired:[
        {data:{...baseline.desired[0].data,start_local:invalid}},
      ]}).success).toBe(false);
    }
    const row={id:locationId,data:baseline.desired[0].data};
    expect(availabilityBatchSchema.safeParse({...baseline,desired:[row]}).success).toBe(false);
    expect(availabilityBatchSchema.safeParse({...baseline,expected:[{id:locationId,revision:1}],
      desired:[row,row]}).success).toBe(false);
    expect(availabilityBatchSchema.safeParse({...baseline,desired:[{
      data:{...baseline.desired[0].data,effective_from:"2026-10-15"},
    }]}).success).toBe(false);
  });
  it("accepts a complete, scoped exception replacement and rejects a cross-date row", () => {
    const input={
      kind:"availability_exception",employeeId,locationId:null,requestKey,
      scope:{local_date:"2026-10-15"},expected:[],
      desired:[{data:{
        employee_id:employeeId,location_id:null,local_date:"2026-10-15",
        exception_type:"hours_cap",max_minutes:60,overnight:false,
        source:"owner_direct",confirmation:"owner_confirmed",
      }}],
    };
    expect(availabilityBatchSchema.safeParse(input).success).toBe(true);
    expect(availabilityBatchSchema.safeParse({...input,desired:[{
      data:{...input.desired[0].data,local_date:"2026-10-16"},
    }]}).success).toBe(false);
  });
});
