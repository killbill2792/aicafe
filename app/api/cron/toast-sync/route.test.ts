import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({db:vi.fn(),tick:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.db}));
vi.mock("@/lib/pos/toast/scheduler",()=>({
 TICK_MS:240000,runToastSyncTick:mocks.tick
}));
import {GET} from "./route";
const req=(header?:string)=>new Request("https://example.test/api/cron/toast-sync",{
 headers:header?{authorization:header}:{}
});
const oldSecret=process.env.CRON_SECRET,oldFlag=process.env.TOAST_AUTO_IMPORT_ENABLED;
beforeEach(()=>{
 process.env.CRON_SECRET="the-private-cron-secret";
 delete process.env.TOAST_AUTO_IMPORT_ENABLED;
 mocks.db.mockReset().mockReturnValue({});
 mocks.tick.mockReset().mockResolvedValue({acquired:1,processed:1,errors:0});
});
afterEach(()=>{
 if(oldSecret===undefined)delete process.env.CRON_SECRET;
 else process.env.CRON_SECRET=oldSecret;
 if(oldFlag===undefined)delete process.env.TOAST_AUTO_IMPORT_ENABLED;
 else process.env.TOAST_AUTO_IMPORT_ENABLED=oldFlag;
});
describe("Toast GET cron auth and disabled behavior (20)",()=>{
 it("rejects a missing bearer even when configured",async()=>{
  expect((await GET(req())).status).toBe(401);
  expect(mocks.db).not.toHaveBeenCalled();
 });
 it("rejects wrong and different-length bearer values without crashing",async()=>{
  for(const bad of ["Bearer wrong","Bearer the-private-cron-secret-extra","Basic the-private-cron-secret"]){
   expect((await GET(req(bad))).status).toBe(401);
  }
  expect(mocks.db).not.toHaveBeenCalled();
 });
 it("fails closed when the secret env value is missing",async()=>{
  delete process.env.CRON_SECRET;
  expect((await GET(req("Bearer any"))).status).toBe(401);
  expect(mocks.db).not.toHaveBeenCalled();
 });
 it("returns 503 with no reads or writes when auto-import flag is off",async()=>{
  const response=await GET(req("Bearer the-private-cron-secret"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({disabled:true});
  expect(mocks.db).not.toHaveBeenCalled();
  expect(mocks.tick).not.toHaveBeenCalled();
 });
 it("calls the tick once with one total 240-second deadline when enabled",async()=>{
  process.env.TOAST_AUTO_IMPORT_ENABLED="true";
  const start=Date.now(),response=await GET(req("Bearer the-private-cron-secret"));
  expect(response.status).toBe(200);
  expect(mocks.db).toHaveBeenCalledTimes(1);
  expect(mocks.tick).toHaveBeenCalledTimes(1);
  const args=mocks.tick.mock.calls[0];
  expect(args[1]).toBeInstanceOf(Date);
  expect(args[2]).toBeGreaterThanOrEqual(start+240000);
  expect(args[2]).toBeLessThanOrEqual(Date.now()+240000);
 });
});
