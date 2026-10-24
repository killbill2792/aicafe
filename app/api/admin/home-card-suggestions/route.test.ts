import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({admin:vi.fn(),upsert:vi.fn()}));
vi.mock("@/lib/admin/auth.server",()=>({requireAdmin:mocks.admin}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  from:()=>({upsert:mocks.upsert}),
})}));
vi.mock("@/lib/ai/conversations/http.server",()=>({
  requireSameOrigin:vi.fn(),readBoundedJson:(r:Request)=>r.json(),
}));
import {POST} from "./route";
describe("Home card suggestion is admin-only and never publishes",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.admin.mockResolvedValue({id:"00000000-0000-4000-8000-000000000001"});
    mocks.upsert.mockResolvedValue({error:null});
  });
  const request=(topic:string)=>new Request("https://test.local/api/admin/home-card-suggestions",
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({topic})});
  it("rejects non-admin before accessing the service client",async()=>{
    mocks.admin.mockRejectedValue(new Error("404"));
    await expect(POST(request("sales"))).rejects.toThrow("404");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects invented topics without writing",async()=>{
    const response=await POST(request("publish_now"));
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("stores an inert suggestion, with duplicate clicks idempotent",async()=>{
    const response=await POST(request("break_even"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({saved:true,published:false});
    expect(mocks.upsert).toHaveBeenCalledWith(
      {topic:"break_even",requested_by:"00000000-0000-4000-8000-000000000001",status:"suggested"},
      {onConflict:"topic",ignoreDuplicates:true});
  });
});
