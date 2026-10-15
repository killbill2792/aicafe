import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({owner:vi.fn(),admin:vi.fn(),rpc:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
import {saveOliviaRuleReview,verifiedOliviaRuleProfile} from "./planPolicy.server";
const biz="10000000-0000-4000-8000-000000000001";
const loc="20000000-0000-4000-8000-000000000002";
const emp="30000000-0000-4000-8000-000000000003";
const actor="40000000-0000-4000-8000-000000000004";
const key="50000000-0000-4000-8000-000000000005";
const profile={
  verified:true as const,source:"Legally reviewed current worker policy reference",
  jurisdictionByLocationId:{[loc]:"Jurisdiction A"},
  classificationByEmployeeId:{[emp]:"Employee hourly"},
  maxContinuousWorkMinutes:360,unpaidMealMinutes:30,
  paidRestMinutes:0,minRestBetweenShiftsMinutes:600,
  overtime:{verified:true as const,dailyAfterMinutes:480,weeklyAfterMinutes:2400,
    multiplierNumerator:3,multiplierDenominator:2},
};
const people={locations:[{id:loc,timezone:"UTC"}],
  employees:[{id:emp,active:true}]};
const request={expectedRevision:0,requestKey:key,attestation:true,profile};
describe("Olivia sourced labor-policy review boundaries",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
    mocks.owner.mockResolvedValue({businessId:biz,
      supabase:{auth:{getUser:async()=>({data:{user:{id:actor}},error:null})}}});
    mocks.rpc.mockResolvedValue({data:{revision:1,replayed:false},error:null});
    mocks.admin.mockReturnValue({rpc:mocks.rpc});
  });
  it("refuses unsourced policy and does not infer unsupported worker types",()=>{
    expect(verifiedOliviaRuleProfile({...profile,source:"short"},people)).toBeNull();
    expect(verifiedOliviaRuleProfile({...profile,
      classificationByEmployeeId:{}},people)).toBeNull();
  });
  it("rejects owner-attested labor rules the planner cannot execute",async()=>{
    const unbreakable={...profile,unpaidMealMinutes:0,paidRestMinutes:0};
    expect(verifiedOliviaRuleProfile(unbreakable,people)).toBeNull();
    const decreasingPremium={...profile,overtime:{...profile.overtime,
      multiplierNumerator:1,multiplierDenominator:2}};
    expect(verifiedOliviaRuleProfile(decreasingPremium,people)).toBeNull();
    const indistinguishable={...profile,paidRestMinutes:30};
    expect(verifiedOliviaRuleProfile(indistinguishable,people)).toBeNull();
    expect(verifiedOliviaRuleProfile({...profile,paidRestMinutes:7},people))
      .toBeNull();
    expect(verifiedOliviaRuleProfile({...profile,paidRestMinutes:10},people)
      ?.paidRestMinutes).toBe(10);
    expect(verifiedOliviaRuleProfile({...profile,paidRestMinutes:0},people)
      ?.paidRestMinutes).toBe(0);
    expect(await saveOliviaRuleReview(
      {...request,profile:decreasingPremium},people,biz))
      .toEqual({ok:false,error:"incomplete_rules"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires attestation and strict typed numeric constraints",async()=>{
    expect(await saveOliviaRuleReview({...request,attestation:false},people,biz))
      .toEqual({ok:false,error:"invalid_input"});
    expect(await saveOliviaRuleReview({...request,profile:{
      ...profile,extraAuthority:true,
    }},people,biz)).toEqual({ok:false,error:"invalid_input"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("checks business authority again before privileged RPC",async()=>{
    mocks.owner.mockResolvedValueOnce(null);
    expect(await saveOliviaRuleReview(request,people,biz))
      .toEqual({ok:false,error:"unauthorized"});
    mocks.owner.mockResolvedValueOnce({businessId:loc});
    expect(await saveOliviaRuleReview(request,people,biz))
      .toEqual({ok:false,error:"tenant_changed"});
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("sends only reviewed owner fields to service-role transaction",async()=>{
    const r=await saveOliviaRuleReview(request,people,biz);
    expect(r).toEqual({ok:true,revision:1,replayed:false});
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_save_labor_rule_review",{
      p_business_id:biz,p_actor_id:actor,p_expected_revision:0,
      p_profile:profile,p_request_key:key,
    });
  });
});
