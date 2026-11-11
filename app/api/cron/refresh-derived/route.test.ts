import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  refresh:vi.fn(async(..._args:unknown[])=>({businessDate:"2026-10-28",alertsCreated:0})),
  calls:0,
  due:vi.fn(async()=>({scopes:1,delivered:1,failed:0})),
  routines:vi.fn(async()=>({routinesChecked:1,runs:1,notices:1,failed:0,evidenceChecks:1})),
}));
vi.mock("@/lib/security/bearer",()=>({verifyBearer:(req:Request,secret:string)=>
  req.headers.get("authorization")==="Bearer "+secret}));
vi.mock("@/lib/alerts/refreshDerived.server",()=>({refreshDerivedForBusiness:mocks.refresh}));
vi.mock("@/lib/operating/commitments.server",()=>({deliverPendingCommitments:mocks.due}));
vi.mock("@/lib/ai/supervisor/routines/dispatch.server",()=>({dispatchRoutinesForBusiness:mocks.routines}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  from:()=>({select(){return this},order(){return this},
    async range(){mocks.calls++;return {data:[
      {id:"a",timezone:"America/Los_Angeles",is_demo:false},
      {id:"b",timezone:"America/New_York",is_demo:false},
      {id:"demo",timezone:"UTC",is_demo:true}],error:null};}}),
})}));
import {GET} from "./route";
beforeEach(()=>{process.env.CRON_SECRET="test-secret";mocks.refresh.mockClear();mocks.due.mockClear();mocks.routines.mockClear();mocks.calls=0});
describe("refresh-derived cron",()=>{
  it("requires authorization before even fetching businesses",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived"));
    expect(result.status).toBe(401);
    expect(mocks.calls).toBe(0);
    expect(mocks.due).not.toHaveBeenCalled();
    expect(mocks.routines).not.toHaveBeenCalled();
  });
  it("runs for each real café without touching the demo tenant",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({checked:2,refreshed:2,failed:0,
      commitments:{scopes:1,delivered:1,failed:0},
      routines:{routinesChecked:2,runs:2,notices:2,failed:0,evidenceChecks:2}});
    expect(mocks.due).toHaveBeenCalledTimes(1);
    expect(mocks.refresh.mock.calls.map(call=>call[1])).toEqual(["a","b"]);
    expect(mocks.routines.mock.calls.map(call=>call[1])).toEqual(["a","b"]);
  });
  it("does not hide successful cafés when a routine fails",async()=>{
    mocks.routines.mockResolvedValueOnce({routinesChecked:0,runs:0,notices:0,failed:1,evidenceChecks:0})
      .mockResolvedValueOnce({routinesChecked:1,runs:1,notices:0,failed:0,evidenceChecks:0});
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(207);
    expect(await result.json()).toMatchObject({refreshed:2,routines:{failed:1}});
  });
});
