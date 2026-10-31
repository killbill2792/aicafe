import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({db:vi.fn(),send:vi.fn(),dispatch:vi.fn(),enqueue:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.db}));
vi.mock("@/lib/operating/dailyBrief.server",()=>({sendDailyBriefs:mocks.send}));
vi.mock("@/lib/whatsapp/morningBriefDelivery.server",()=>({enqueueBoundBrief:mocks.enqueue,dispatchDueMorningBriefs:mocks.dispatch}));
import {GET} from "./route";
const req=(header?:string)=>new Request("https://example.test/api/cron/daily-brief",{headers:header?{authorization:header}:{}});
const old={secret:process.env.CRON_SECRET,flag:process.env.DAILY_BRIEF_ENABLED};
beforeEach(()=>{
  process.env.CRON_SECRET="the-private-cron-secret";delete process.env.DAILY_BRIEF_ENABLED;
  mocks.db.mockReset().mockReturnValue({});
  mocks.send.mockReset().mockResolvedValue({checked:1,sent:1,skipped:0,failed:0});
  mocks.dispatch.mockReset().mockResolvedValue(0);
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
});
afterEach(()=>{
  if(old.secret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old.secret;
  if(old.flag===undefined)delete process.env.DAILY_BRIEF_ENABLED;else process.env.DAILY_BRIEF_ENABLED=old.flag;
});
describe("daily brief cron",()=>{
  it("rejects a missing or wrong bearer",async()=>{
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("stays off until DAILY_BRIEF_ENABLED=true, before touching the database",async()=>{
    const off=await GET(req("Bearer the-private-cron-secret"));
    expect(off.status).toBe(503);
    expect(mocks.db).not.toHaveBeenCalled();
    process.env.DAILY_BRIEF_ENABLED="true";
    const on=await GET(req("Bearer the-private-cron-secret"));
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(mocks.send).toHaveBeenCalledWith({},expect.any(Date),expect.any(Function));
    expect(mocks.dispatch).toHaveBeenCalledWith({});
  });
  it("hides error details",async()=>{
    process.env.DAILY_BRIEF_ENABLED="true";
    mocks.send.mockRejectedValue(new Error("secret detail"));
    const res=await GET(req("Bearer the-private-cron-secret"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
