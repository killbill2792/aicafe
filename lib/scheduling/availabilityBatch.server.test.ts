import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./foundation.server", () => ({
  requireSchedulingOwner: mocks.owner,
}));

import { saveAvailabilityBatch } from "./availabilityBatch.server";

const employeeId = "10000000-0000-4000-8000-000000000001";
const requestKey = "10000000-0000-4000-8000-000000000002";
const input = {
  kind: "availability_rule", employeeId, locationId: null, requestKey,
  scope: { effective_from:"2026-10-14",effective_to:null },
  expected: [],
  desired: [{ data:{
    employee_id:employeeId,location_id:null,
    day_of_week:3,start_local:"07:00",end_local:"11:00",overnight:false,
    effective_from:"2026-10-14",effective_to:null,
    source:"owner_direct",confirmation:"owner_confirmed",
  }}],
};

describe("Olivia PR1B owner batch server boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_AVAILABILITY_UI_ENABLED="true";
    mocks.owner.mockResolvedValue({
      businessId:"10000000-0000-4000-8000-000000000010",
      supabase:{rpc:mocks.rpc},
    });
    mocks.rpc.mockResolvedValue({
      data:{replayed:false,records:[{id:employeeId,revision:1}]},error:null,
    });
  });
  it("fails closed with flags disabled and never calls a privileged RPC", async()=>{
    process.env.SCHEDULING_AVAILABILITY_UI_ENABLED="false";
    expect(await saveAvailabilityBatch(input)).toEqual({ok:false,error:"disabled"});
    expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("rejects forged tenants and invalid records before authorization",async()=>{
    expect(await saveAvailabilityBatch({...input,business_id:employeeId})).toEqual({
      ok:false,error:"invalid_input",
    });
    expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("requires an authenticated owner, including for reads/writes on demo tenant",async()=>{
    mocks.owner.mockResolvedValue(null);
    expect(await saveAvailabilityBatch(input)).toEqual({ok:false,error:"unauthorized"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("forwards exactly the resolved café and idempotency key to the atomic RPC",async()=>{
    expect(await saveAvailabilityBatch(input)).toEqual({
      ok:true,replayed:false,records:[{id:employeeId,revision:1}],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_save_availability_batch",{
      p_business_id:"10000000-0000-4000-8000-000000000010",
      p_employee_id:employeeId,p_location_id:null,p_kind:"availability_rule",
      p_scope:input.scope,p_expected:[],p_desired:input.desired,p_request_key:requestKey,
    });
  });
  it("distinguishes persisted replay and conflicting use of an existing key",async()=>{
    mocks.rpc.mockResolvedValueOnce({data:{
      replayed:true,records:[{id:employeeId,revision:1}],
    },error:null});
    expect(await saveAvailabilityBatch(input)).toMatchObject({ok:true,replayed:true});
    mocks.rpc.mockResolvedValueOnce({data:{conflict:true},error:null});
    expect(await saveAvailabilityBatch(input)).toEqual({ok:false,error:"conflict"});
  });
  it("does not expose SQL internals on database errors or corrupt result",async()=>{
    mocks.rpc.mockResolvedValueOnce({data:null,error:{message:"private SQL diagnostics"}});
    expect(await saveAvailabilityBatch(input)).toEqual({ok:false,error:"storage_unavailable"});
    mocks.rpc.mockResolvedValueOnce({data:{records:[{id:employeeId,revision:0}],replayed:false},error:null});
    expect(await saveAvailabilityBatch(input)).toEqual({ok:false,error:"storage_unavailable"});
  });
});
