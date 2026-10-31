import {beforeEach,describe,expect,it,vi} from "vitest";
const spies=vi.hoisted(()=>({
  enabled:vi.fn(),kind:vi.fn(),deliver:vi.fn(),db:vi.fn(),
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:spies.db}));
vi.mock("@/lib/ai/notifications/whatsapp.server",()=>({
  notificationEnabled:spies.enabled,safeTaskKind:spies.kind,deliverOwnerTemplate:spies.deliver,
}));
vi.mock("@/lib/metrics/core/clock",()=>({cafeToday:()=> "2026-10-31"}));
import {GET} from "./route";
function setup(hasBrief:boolean){
  const mutations:string[]=[];
  const db={
    auth:{admin:{getUserById:async()=>({data:{user:{
      phone:"+15556506570",phone_confirmed_at:"2026-10-30T00:00:00Z"}},error:null})}},
    from:(table:string)=>{
      const query:Record<string,unknown>={};
      for(const name of ["select","eq","order","in"])query[name]=()=>query;
      query.limit=async()=>({data:table==="ai_owner_notifications"?
        [{business_id:"cafe-a",owner_user_id:"owner-a",phone_e164:"+15556506570"}]:
        table==="operating_tasks"?[{id:"task-1",kind:"money_update",status:"needs_owner"}]:
        table==="whatsapp_outbox"?(hasBrief?[{id:"brief-outbound"}]:[]):[],error:null});
      query.single=async()=>({data:table==="businesses"?{timezone:"America/Los_Angeles"}:{id:"delivery-1"},error:null});
      query.maybeSingle=async()=>({data:{role:"owner"},error:null});
      query.insert=()=>{mutations.push("insert");return query;};
      query.update=()=>{mutations.push("update");return query;};
      query.then=(done:(result:unknown)=>void)=>done({data:[],error:null});
      return query;
    },
  };
  spies.db.mockReturnValue(db);
  return {mutations};
}
beforeEach(()=>{
  process.env.CRON_SECRET="unit-cron-secret";
  spies.db.mockReset();spies.enabled.mockReset().mockReturnValue(true);
  spies.kind.mockReset().mockReturnValue("money_update");
  spies.deliver.mockReset().mockResolvedValue({sent:true,providerId:"provider-1"});
});
describe("legacy WhatsApp task-alert coexists with canonical morning brief",()=>{
  const req=()=>new Request("https://example.test/api/cron/team-alerts",{
    headers:{authorization:"Bearer unit-cron-secret"}});
  it("does not duplicate a task template for an owner with a reserved daily brief",async()=>{
    const {mutations}=setup(true);
    const response=await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({sent:0});
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });
  it("keeps the existing legacy task notification when no daily brief exists",async()=>{
    const {mutations}=setup(false);
    const response=await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({sent:1,failed:0});
    expect(spies.deliver).toHaveBeenCalledTimes(1);
    expect(mutations).toEqual(["insert","update"]);
  });
});
