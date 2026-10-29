import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  refresh:vi.fn(async(..._args:unknown[])=>({businessDate:"2026-10-28",alertsCreated:0})),
  calls:0,
}));
vi.mock("@/lib/security/bearer",()=>({verifyBearer:(req:Request,secret:string)=>
  req.headers.get("authorization")==="Bearer "+secret}));
vi.mock("@/lib/alerts/refreshDerived.server",()=>({refreshDerivedForBusiness:mocks.refresh}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  from:()=>({select(){return this},order(){return this},
    async range(){mocks.calls++;return {data:[
      {id:"a",timezone:"America/Los_Angeles",is_demo:false},
      {id:"b",timezone:"America/New_York",is_demo:false},
      {id:"demo",timezone:"UTC",is_demo:true}],error:null};}}),
})}));
import {GET} from "./route";
beforeEach(()=>{process.env.CRON_SECRET="test-secret";mocks.refresh.mockClear();mocks.calls=0});
describe("refresh-derived cron",()=>{
  it("requires authorization before even fetching businesses",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived"));
    expect(result.status).toBe(401);
    expect(mocks.calls).toBe(0);
  });
  it("runs for each real café without touching the demo tenant",async()=>{
    const result=await GET(new Request("https://example.test/api/cron/refresh-derived",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({checked:2,refreshed:2,failed:0});
    expect(mocks.refresh.mock.calls.map(call=>call[1])).toEqual(["a","b"]);
  });
});
