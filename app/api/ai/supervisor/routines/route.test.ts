import {beforeEach,describe,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({
  scope:{businessId:"11111111-1111-4111-8111-111111111111",
    ownerUserId:"22222222-2222-4222-8222-222222222222"},
  denied:false,reader:vi.fn(async(_scope:unknown,_client:unknown)=>[{id:"routine-1",title:"Daily source check"}]),
}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:async()=>{
    if(f.denied)throw new Error("owner_access_required");
    return {scope:f.scope,service:{}};
  },
}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:async()=>({id:"authenticated-client"}),
}));
vi.mock("@/lib/ai/supervisor/routines/repository.server",()=>({
  listOwnerRoutinesAcrossThreads:(scope:unknown,client:unknown)=>f.reader(scope,client),
}));
import {GET} from "./route";
beforeEach(()=>{f.denied=false;f.reader.mockClear();});
describe("owner library routines read-only endpoint",()=>{
  it("reads real saved routines only for the authenticated café and owner",async()=>{
    const response=await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      routines:[{id:"routine-1",title:"Daily source check"}],
    });
    expect(f.reader).toHaveBeenCalledWith(f.scope,{id:"authenticated-client"});
  });
  it("cannot return routines without owner authentication",async()=>{
    f.denied=true;
    const response=await GET();
    expect(response.status).not.toBe(200);
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("does not present a failed reader as an empty library",async()=>{
    f.reader.mockRejectedValueOnce(new Error("database offline"));
    const response=await GET();
    expect(response.status).not.toBe(200);
  });
});
