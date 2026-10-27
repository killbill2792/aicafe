import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({db:vi.fn(),tick:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.db}));
vi.mock("@/lib/pos/square/scheduler",()=>({syncSquareTick:mocks.tick}));
import {GET} from "./route";
const req=(header?:string)=>new Request("https://example.test/api/cron/square-sync",{
 headers:header?{authorization:header}:{}
});
const originalSecret=process.env.CRON_SECRET,originalFlag=process.env.SQUARE_AUTO_SYNC_ENABLED;
beforeEach(()=>{
 process.env.CRON_SECRET="private-square-cron-test-secret";
 delete process.env.SQUARE_AUTO_SYNC_ENABLED;
 mocks.db.mockReset().mockReturnValue({});
 mocks.tick.mockReset().mockResolvedValue({synced:1,failed:0});
});
afterEach(()=>{
 if(originalSecret===undefined)delete process.env.CRON_SECRET;
 else process.env.CRON_SECRET=originalSecret;
 if(originalFlag===undefined)delete process.env.SQUARE_AUTO_SYNC_ENABLED;
 else process.env.SQUARE_AUTO_SYNC_ENABLED=originalFlag;
});
describe("Square cron feature flag and authorization",()=>{
 it("returns 401 for absent, invalid or unconfigured CRON_SECRET, even with auto-sync disabled",async()=>{
  for(const bearer of [undefined,"Bearer bad","Basic private-square-cron-test-secret"]){
   expect((await GET(req(bearer))).status).toBe(401);
  }
  delete process.env.CRON_SECRET;
  expect((await GET(req("Bearer anything"))).status).toBe(401);
  expect(mocks.db).not.toHaveBeenCalled();
  expect(mocks.tick).not.toHaveBeenCalled();
 });
 it("returns HTTP 200 disabled:true for an authorized cron when flag is unset or off",async()=>{
  for(const flag of [undefined,"false","TRUE","1"]){
   if(flag===undefined)delete process.env.SQUARE_AUTO_SYNC_ENABLED;
   else process.env.SQUARE_AUTO_SYNC_ENABLED=flag;
   const response=await GET(req("Bearer private-square-cron-test-secret"));
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual({disabled:true});
   expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(mocks.db).not.toHaveBeenCalled();
  expect(mocks.tick).not.toHaveBeenCalled();
 });
 it("runs one Square tick only when correctly authorized and flag is exactly true",async()=>{
  process.env.SQUARE_AUTO_SYNC_ENABLED="true";
  const response=await GET(req("Bearer private-square-cron-test-secret"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({synced:1,failed:0});
  expect(mocks.db).toHaveBeenCalledTimes(1);
  expect(mocks.tick).toHaveBeenCalledTimes(1);
  expect(mocks.tick).toHaveBeenCalledWith(mocks.db.mock.results[0].value);
 });
 it("returns 503 without disclosing scheduler errors when an enabled tick fails",async()=>{
  process.env.SQUARE_AUTO_SYNC_ENABLED="true";
  mocks.tick.mockRejectedValue(new Error("private provider token"));
  const response=await GET(req("Bearer private-square-cron-test-secret"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:"sync_unavailable"});
 });
});
