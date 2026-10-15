import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  user:vi.fn(),activeId:vi.fn(),supabase:vi.fn(),tools:vi.fn(),identity:vi.fn(),
}));
vi.mock("@/lib/auth/requireUser",()=>({requireOwnBusiness:mocks.user}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:mocks.activeId}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mocks.supabase}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  createAuthenticatedCafeTools:mocks.tools,readSupervisorCafeIdentity:mocks.identity,
}));
import {discoverAuthenticatedP1,readAuthenticatedP1} from "./p1Readers.server";

const query={id:"money.monthly_bills",version:1,purpose:"recurring_obligation_review"};
const readBills=vi.fn();
const membership=vi.fn();
const eq=vi.fn();
const from=vi.fn();
const client={from};

beforeEach(()=>{
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({id:"owner1"});
  mocks.activeId.mockResolvedValue("business1");
  mocks.supabase.mockResolvedValue(client);
  mocks.tools.mockResolvedValue({getMonthlyBills:readBills});
  mocks.identity.mockResolvedValue({asOf:"2026-10-14",timezone:"America/Los_Angeles"});
  membership.mockResolvedValue({data:{role:"owner",businesses:{is_demo:false}},error:null});
  eq.mockReturnValue({eq,maybeSingle:membership});
  from.mockReturnValue({select:()=>({eq})});
  readBills.mockResolvedValue({available:true,value:{totalCents:0},
    quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}});
});

describe("P1 production owner/tenant authorization",()=>{
  it("denies signed-out callers before touching any business source",async()=>{
    mocks.user.mockResolvedValue(null);
    expect(await readAuthenticatedP1(query)).toEqual({status:"unavailable",value:null,reason:"unauthorized"});
    expect(readBills).not.toHaveBeenCalled();
    expect(mocks.tools).not.toHaveBeenCalled();
  });
  it("denies selected non-owner café membership, including shared/demo tenants",async()=>{
    for(const m of [
      {data:null,error:null},
      {data:{role:"manager",businesses:{is_demo:false}},error:null},
      {data:{role:"owner",businesses:{is_demo:true}},error:null},
    ]){
      membership.mockResolvedValue(m);
      const denied=await readAuthenticatedP1(query);
      expect(denied).toEqual({status:"unavailable",value:null,reason:"unauthorized"});
      expect(readBills).not.toHaveBeenCalled();
    }
    expect(eq).toHaveBeenCalledWith("business_id","business1");
    expect(eq).toHaveBeenCalledWith("role","owner");
    expect(eq).toHaveBeenCalledWith("user_id","owner1");
    expect(from).toHaveBeenCalledWith("memberships");
  });
  it("binds the selected authorized café identity and prevents caller-selected tenancy",async()=>{
    const result=await readAuthenticatedP1(query);
    expect(result).toMatchObject({status:"partial",value:{totalCents:0}});
    expect(readBills).toHaveBeenCalledTimes(1);
    expect(mocks.identity).toHaveBeenCalledWith("business1");
    expect(await readAuthenticatedP1({...query,businessId:"other-cafe"}))
      .toEqual({status:"unavailable",value:null,reason:"invalid_request"});
    expect(readBills).toHaveBeenCalledTimes(1);
  });
  it("never trusts a mutable is_demo=false on the immutable shared demo café",async()=>{
    mocks.activeId.mockResolvedValue("11111111-1111-1111-1111-111111111111");
    membership.mockResolvedValue({data:{role:"owner",businesses:{is_demo:false}},error:null});
    expect(await readAuthenticatedP1(query)).toEqual({
      status:"unavailable",value:null,reason:"unauthorized",
    });
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(readBills).not.toHaveBeenCalled();
  });
  it("restricts discovery itself and returns metadata only",async()=>{
    const defs=await discoverAuthenticatedP1();
    expect(defs.some(d=>d.id==="labor.employee_wages")).toBe(true);
    expect(JSON.stringify(defs)).not.toContain("owner1");
    membership.mockResolvedValue({data:null,error:null});
    await expect(discoverAuthenticatedP1()).rejects.toThrow();
  });
});
