import {beforeEach,describe,expect,it,vi} from "vitest";
import type {PlannerInput,PlannerScenario} from "@/lib/calc/scheduling/plannerTypes";
const mocks=vi.hoisted(()=>({
  load:vi.fn(),owner:vi.fn(),digest:vi.fn(),validate:vi.fn(),
  admin:vi.fn(),rpc:vi.fn(),series:vi.fn(),revision:vi.fn(),assignments:vi.fn(),
  verifyRevision:vi.fn(),verifyPublished:vi.fn(),
}));
vi.mock("server-only",()=>({}));
vi.mock("./planInput.server",()=>({loadOliviaWeekFromSavedStaff:mocks.load}));
vi.mock("./foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("./planDrafts.server",()=>({oliviaSnapshotDigest:mocks.digest}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
vi.mock("@/lib/calc/scheduling/plannerValidate",()=>({
  validateOliviaAssignments:mocks.validate,
}));
import {transitionOliviaPlan} from "./planPublication.server";
const biz="10000000-0000-4000-8000-000000000001";
const seriesId="20000000-0000-4000-8000-000000000002";
const revisionId="30000000-0000-4000-8000-000000000003";
const actor="40000000-0000-4000-8000-000000000004";
const requestKey="50000000-0000-4000-8000-000000000005";
const digest="a".repeat(64),sourceToken="b".repeat(32);
const scenario:PlannerScenario={objective:"balanced",shifts:[],gaps:[],
  completeCoverage:true,hardConstraintsSatisfied:true,ownerMinutes:0,
  preferencePenalty:0,exploredNodes:1,legalReview:"verified_profile",
  cost:{cashWagesCents:0,allocatedSalaryCents:0,loadedPayrollCents:0,
    ownerOpportunityCents:0,ownerMinutes:0,costState:"verified",
    missingWageEmployeeIds:[]}};
const input:PlannerInput={horizonStart:"2026-10-12",locations:[],
  employees:[],coverage:[],slotMinutes:30,ruleProfile:{
    verified:true,source:"owner verified jurisdiction policy",
    overtime:{verified:true,multiplierNumerator:3,multiplierDenominator:2},
  }};
const payload={week:"2026-10-12",revisionId,expectedRevision:2,requestKey};
function buildQuery(result:()=>Promise<unknown>){
  const q={select:()=>q,eq:()=>q,limit:(_n:number)=>
    result(),maybeSingle:result};
  return q;
}
describe("Olivia PR3 guarded approval and publishing",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
    process.env.SCHEDULING_PR3_PUBLICATION_ENABLED="true";
    mocks.load.mockResolvedValue({
      ok:true,input,businessId:biz,sourceFingerprint:"c".repeat(64),
      sourceToken,blockers:[],
    });
    mocks.digest.mockReturnValue(digest);
    mocks.series.mockResolvedValue({data:{id:seriesId,current_revision:2,
      published_revision:null},error:null});
    mocks.revision.mockResolvedValueOnce({data:{id:revisionId,revision:2,
      status:"draft",scenario,source_digest:digest},error:null});
    mocks.verifyRevision.mockResolvedValue({data:{status:"approved",
      approved_by:actor,published_by:null},error:null});
    mocks.verifyPublished.mockResolvedValue({data:{published_revision:2},error:null});
    mocks.assignments.mockResolvedValue({data:[],error:null});
    mocks.validate.mockReturnValue({valid:true,completeCoverage:true,
      matchingBudgetExhausted:false});
    mocks.rpc.mockResolvedValue({data:{revisionId,revision:2,
      status:"approved",replayed:false},error:null});
    mocks.admin.mockReturnValue({rpc:mocks.rpc});
    let revisionCall=0;
    mocks.owner.mockImplementation(async()=>({businessId:biz,supabase:{
      auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},
      from:(table:string)=>{
        if(table==="scheduling_plan_series")
          return buildQuery(mocks.series);
        if(table==="scheduling_plan_assignments")
          return buildQuery(mocks.assignments);
        if(table==="scheduling_plan_revisions"){
          revisionCall++;
          return buildQuery(revisionCall===1?mocks.revision:mocks.verifyRevision);
        }
        throw new Error("unreachable");
      },
    }}));
  });
  it("does not call a privileged RPC with feature flags off",async()=>{
    process.env.SCHEDULING_PR3_PUBLICATION_ENABLED="false";
    expect(await transitionOliviaPlan(payload,"approve"))
      .toEqual({ok:false,error:"disabled"});
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects forged browser fields before any effect",async()=>{
    expect(await transitionOliviaPlan({...payload,businessId:biz},"publish"))
      .toEqual({ok:false,error:"invalid_input"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects unsourced legal rules, even for owner-claimed feasibility",async()=>{
    mocks.load.mockResolvedValueOnce({ok:true,businessId:biz,
      input:{...input,ruleProfile:undefined},blockers:[]});
    expect(await transitionOliviaPlan(payload,"approve"))
      .toEqual({ok:false,error:"policy_unverified"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("refuses to use a different currently selected business",async()=>{
    mocks.owner.mockResolvedValueOnce({businessId:seriesId});
    expect(await transitionOliviaPlan(payload,"approve"))
      .toEqual({ok:false,error:"source_changed"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects stale source digests instead of trusting caller revision",async()=>{
    mocks.revision.mockReset().mockResolvedValue({data:{
      id:revisionId,revision:2,status:"draft",
      scenario,source_digest:"f".repeat(64),
    },error:null});
    expect(await transitionOliviaPlan(payload,"approve"))
      .toEqual({ok:false,error:"source_changed"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("checks exact version, pure constraints, and readback on approval",async()=>{
    const result=await transitionOliviaPlan(payload,"approve");
    expect(result).toEqual({ok:true,status:"approved",revisionId,
      revision:2,replayed:false});
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_pr3_approve",{
      p_business_id:biz,p_actor_id:actor,p_revision_id:revisionId,
      p_expected_revision:2,p_source_digest:digest,p_source_token:sourceToken,
      p_request_key:requestKey,
    });
  });
  it("reports database-declared source changes without claiming approval",async()=>{
    mocks.rpc.mockResolvedValueOnce({data:{error:"source_changed"},error:null});
    expect(await transitionOliviaPlan(payload,"approve"))
      .toEqual({ok:false,error:"source_changed"});
  });
});
