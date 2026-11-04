import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({db:vi.fn(),label:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.db}));
vi.mock("@/lib/menu/drinkLabels.server",()=>({labelAllCafesMenuCategories:mocks.label}));
import {GET} from "./route";
const req=(header?:string)=>new Request("https://example.test/api/cron/menu-labels",{headers:header?{authorization:header}:{}});
const old=process.env.CRON_SECRET;
beforeEach(()=>{process.env.CRON_SECRET="the-private-cron-secret";
  mocks.db.mockReset().mockReturnValue({});mocks.label.mockReset().mockResolvedValue({cafes:2,labeled:7,stoppedEarly:false});});
afterEach(()=>{if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;});
describe("menu labels cron",()=>{
  it("rejects a missing or wrong bearer before touching the database",async()=>{
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("labels every café with no WhatsApp or brief flag involved",async()=>{
    for(const name of ["DAILY_BRIEF_ENABLED","WHATSAPP_PROVIDER_SEND_ENABLED"])delete process.env[name];
    const res=await GET(req("Bearer the-private-cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({cafes:2,labeled:7,stoppedEarly:false});
  });
  it("hides error details",async()=>{
    mocks.label.mockRejectedValue(new Error("secret detail"));
    const res=await GET(req("Bearer the-private-cron-secret"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
