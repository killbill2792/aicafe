import {beforeEach,describe,expect,it,vi} from "vitest";
import type {PlannerInput,PlannerScenario} from "@/lib/calc/scheduling/plannerTypes";

const mocks=vi.hoisted(()=>({
  owner:vi.fn(),digest:vi.fn(),validate:vi.fn(),rpc:vi.fn(),
  series:vi.fn(),revision:vi.fn(),
}));
vi.mock("server-only",()=>({}));
vi.mock("./foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("./planDrafts.server",()=>({oliviaSnapshotDigest:mocks.digest}));
vi.mock("@/lib/calc/scheduling/plannerValidate",()=>({
  validateOliviaAssignments:mocks.validate,
}));
import {saveOliviaEditedDraft} from "./planEdits.server";

const businessId="10000000-0000-4000-8000-000000000001";
const seriesId="20000000-0000-4000-8000-000000000002";
const revisionId="30000000-0000-4000-8000-000000000003";
const createdId="40000000-0000-4000-8000-000000000004";
const requestKey="50000000-0000-4000-8000-000000000005";
const digest="a".repeat(64),sourceFingerprint="b".repeat(64);
const input:PlannerInput={horizonStart:"2026-10-12",locations:[{
  id:seriesId,timezone:"UTC",
}],employees:[],coverage:[],slotMinutes:30};
const scenario:PlannerScenario={
  objective:"balanced",shifts:[],gaps:[],completeCoverage:true,
  hardConstraintsSatisfied:true,ownerMinutes:0,preferencePenalty:0,
  exploredNodes:1,legalReview:"unverified_profile",
  cost:{cashWagesCents:0,allocatedSalaryCents:0,loadedPayrollCents:0,
    ownerOpportunityCents:0,ownerMinutes:0,costState:"verified",
    missingWageEmployeeIds:[]},
};
const edit={horizonStart:input.horizonStart,expectedRevision:1,
  baseRevisionId:revisionId,objective:"balanced" as const,
  expectedSourceDigest:digest,requestKey,shifts:[]};
function query(result:()=>Promise<unknown>){
  const q={select:()=>q,eq:()=>q,maybeSingle:result};
  return q;
}
describe("Olivia immutable owner schedule edit service",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
    mocks.digest.mockReturnValue(digest);
    mocks.series.mockResolvedValue({data:{id:seriesId,current_revision:1},error:null});
    mocks.revision.mockResolvedValue({data:{id:revisionId,status:"draft",
      source_digest:digest,scenario},error:null});
    mocks.rpc.mockResolvedValue({data:{seriesId,revisionId:createdId,
      revision:2,replayed:false},error:null});
    mocks.validate.mockReturnValue({valid:true,completeCoverage:true,
      violations:[],gaps:[],matchingBudgetExhausted:false,cost:scenario.cost});
    mocks.owner.mockImplementation(async()=>({businessId,supabase:{
      from:(table:string)=>table==="scheduling_plan_series" ?
        query(mocks.series):query(mocks.revision),
      rpc:mocks.rpc,
    }}));
  });
  it("requires owner-only flags before touching records",async()=>{
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="false";
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"disabled"});
    expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("rejects forged tenant and money fields before any owner read",async()=>{
    expect(await saveOliviaEditedDraft({...edit,business_id:businessId},
      input,businessId,sourceFingerprint)).toEqual({ok:false,error:"invalid_input"});
    expect(await saveOliviaEditedDraft({...edit,shifts:[{
      employeeId:seriesId,locationId:seriesId,startAt:"2026-10-12T09:00:00.000Z",
      endAt:"2026-10-12T10:00:00.000Z",paidMinutes:60,
      breaks:[],pinned:false,wage_amount_cents:0,
    }]},input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"invalid_input"});
    expect(mocks.owner).not.toHaveBeenCalled();
  });
  it("rejects stale source data and changed selected business",async()=>{
    mocks.digest.mockReturnValueOnce("c".repeat(64));
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"source_changed"});
    mocks.owner.mockResolvedValueOnce({businessId:revisionId});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"tenant_changed"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects stale base revision and absent/mismatched authoritative draft",async()=>{
    mocks.series.mockResolvedValueOnce({data:{id:seriesId,current_revision:2},error:null});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"revision_conflict"});
    mocks.revision.mockResolvedValueOnce({data:{id:revisionId,status:"draft",
      source_digest:"c".repeat(64),scenario},error:null});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"source_changed"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects changes violating the pure hard-constraint checker",async()=>{
    mocks.validate.mockReturnValueOnce({valid:false,completeCoverage:false,
      violations:["outside_confirmed_availability:worker"],gaps:[],
      cost:null,matchingBudgetExhausted:false});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"invalid_shifts",
        violations:["outside_confirmed_availability:worker"]});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("never removes, unpins or reassigns an existing pinned commitment",async()=>{
    const pinned={employeeId:businessId,locationId:seriesId,
      startAt:"2026-10-12T09:00:00.000Z",
      endAt:"2026-10-12T10:00:00.000Z",
      paidMinutes:60,breaks:[],pinned:true};
    mocks.revision.mockResolvedValueOnce({data:{id:revisionId,status:"draft",
      source_digest:digest,scenario:{...scenario,shifts:[pinned]}},error:null});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"invalid_shifts",
        violations:["pinned_shift_changed"]});
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("creates a new revision with server-calculated cost and exact CAS",async()=>{
    const output=await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint);
    expect(output).toMatchObject({ok:true,revision:2,replayed:false});
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_create_plan_draft",{
      p_business_id:businessId,p_horizon_start:"2026-10-12",
      p_expected_revision:1,p_source_digest:digest,p_planner_input:input,
      p_scenario:{...scenario,exploredNodes:0},
      p_shifts:[],p_request_key:requestKey,
    });
  });
  it("rejects nonconforming database result instead of fabricating success",async()=>{
    mocks.rpc.mockResolvedValueOnce({data:{revision:2,conflict:true},error:null});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"revision_conflict"});
    mocks.rpc.mockResolvedValueOnce({data:{seriesId,revisionId:createdId,
      revision:4,replayed:false},error:null});
    expect(await saveOliviaEditedDraft(edit,input,businessId,sourceFingerprint))
      .toEqual({ok:false,error:"storage_unavailable"});
  });
});
