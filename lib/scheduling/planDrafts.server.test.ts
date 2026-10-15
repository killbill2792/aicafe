import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannerInput, PlannerScenario } from "@/lib/calc/scheduling/plannerTypes";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(), optimize: vi.fn(), validate: vi.fn(), rpc: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./foundation.server", () => ({requireSchedulingOwner:mocks.owner}));
vi.mock("@/lib/calc/scheduling/plannerEngine",()=>({optimizeOliviaWeek:mocks.optimize}));
vi.mock("@/lib/calc/scheduling/plannerValidate",()=>({validateOliviaAssignments:mocks.validate}));

import { createOliviaDraftFromTrustedSnapshot, oliviaSnapshotDigest } from "./planDrafts.server";

const businessId="10000000-0000-4000-8000-000000000001";
const sourceFingerprint="b".repeat(64);
const requestKey="20000000-0000-4000-8000-000000000002";
const seriesId="30000000-0000-4000-8000-000000000003";
const revisionId="40000000-0000-4000-8000-000000000004";
const snapshot:PlannerInput={
  horizonStart:"2026-10-12",locations:[{id:businessId,timezone:"UTC"}],
  employees:[],coverage:[],slotMinutes:30,
};
const scenario:PlannerScenario={
  objective:"balanced",shifts:[],gaps:[],completeCoverage:true,
  hardConstraintsSatisfied:true,ownerMinutes:0,
  cost:{cashWagesCents:0,allocatedSalaryCents:0,loadedPayrollCents:0,
    ownerOpportunityCents:0,ownerMinutes:0,costState:"verified",
    missingWageEmployeeIds:[]},
  preferencePenalty:0,exploredNodes:1,legalReview:"unverified_profile",
};
const opts={horizonStart:snapshot.horizonStart,
  expectedRevision:0,requestKey,objective:"balanced" as const};

describe("Olivia PR3B internal-only draft persistence boundary",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
    mocks.owner.mockResolvedValue({businessId,supabase:{rpc:mocks.rpc}});
    mocks.optimize.mockReturnValue({scenarios:[scenario]});
    mocks.validate.mockReturnValue({valid:true});
    mocks.rpc.mockResolvedValue({data:{seriesId,revisionId,revision:1,replayed:false},
      error:null});
  });
  it("never grants access with feature flags disabled",async()=>{
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="false";
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"disabled"});
    expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("rejects lost owner access",async()=>{
    mocks.owner.mockResolvedValue(null);
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"unauthorized"});
  });
  it("rejects a selected-business change after loading staff facts",async()=>{
    mocks.owner.mockResolvedValue({businessId:seriesId,supabase:{rpc:mocks.rpc}});
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"tenant_changed"});
    expect(mocks.optimize).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects fraudulent options and unvalidated generated assignments",async()=>{
    expect(await createOliviaDraftFromTrustedSnapshot({...opts,
      businessId},snapshot,businessId,sourceFingerprint)).toEqual({ok:false,error:"invalid_input"});
    mocks.validate.mockReturnValueOnce({valid:false});
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"invalid_input"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("writes a deterministic source digest into the tenant-scoped draft RPC",async()=>{
    const result=await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint);
    expect(result).toMatchObject({ok:true,seriesId,revisionId,revision:1,replayed:false});
    expect(oliviaSnapshotDigest(snapshot,sourceFingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_create_plan_draft",{
      p_business_id:businessId,p_horizon_start:snapshot.horizonStart,
      p_expected_revision:0,p_source_digest:oliviaSnapshotDigest(snapshot,sourceFingerprint),
      p_planner_input:snapshot,p_scenario:scenario,p_shifts:[],
      p_request_key:requestKey,
    });
  });
  it("rejects plans over the SQL assignment cap without mistaking them for storage downtime",async()=>{
    mocks.optimize.mockReturnValue({scenarios:[{
      ...scenario,shifts:Array.from({length:201},()=>({
        employeeId:businessId,locationId:businessId,
        startAt:"2026-10-12T08:00:00Z",endAt:"2026-10-12T09:00:00Z",
        paidMinutes:60,breaks:[],pinned:false,
      })),
    }]});
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"capacity_exceeded"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed for SQL errors and corrupt RPC responses",async()=>{
    mocks.rpc.mockResolvedValueOnce({data:null,error:{code:"42501"}});
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"storage_unavailable"});
    mocks.rpc.mockResolvedValueOnce({data:{seriesId,revisionId,revision:0,replayed:false},error:null});
    expect(await createOliviaDraftFromTrustedSnapshot(opts,snapshot,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"storage_unavailable"});
  });
});
