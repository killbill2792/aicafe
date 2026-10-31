import {describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({session:vi.fn(),cookie:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("./readiness",()=>({supervisorChatConfigStatus:()=>({enabled:true,reason:null})}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:m.session}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>{throw Error("not a user session")}}));
vi.mock("./auth.server",()=>({authenticatedConversationContext:m.cookie,
 ConversationApiError:class ConversationApiError extends Error{}}));
import {getSupervisorChatReadinessForAuthorizedExternal} from "./enabled.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const scoped=(role:string,broken:string|null=null)=>({
 from:vi.fn((name:string)=>{
   const query={
     select:()=>query,eq:()=>query,
     maybeSingle:async()=>({data:{role},error:broken===name?{code:"error"}:null}),
     limit:async()=>({data:[],error:broken===name?{code:"error"}:null}),
   };
   return query;
 }),
});
describe("external Supervisor readiness keeps explicit owner/café scope",()=>{
 it("checks canonical tables without a website cookie",async()=>{
   m.cookie.mockReset();m.session.mockReset();
   const db=scoped("owner");
   expect(await getSupervisorChatReadinessForAuthorizedExternal(scope,db as never))
      .toEqual({enabled:true,reason:null});
   expect(m.cookie).not.toHaveBeenCalled();
   expect(m.session).not.toHaveBeenCalled();
   expect(db.from).toHaveBeenCalledWith("memberships");
   expect(db.from).toHaveBeenCalledWith("ai_threads");
   expect(db.from).toHaveBeenCalledWith("ai_messages");
   expect(db.from).toHaveBeenCalledWith("ai_usage_events");
 });
 it("denies non-owner membership before considering storage ready",async()=>{
   expect(await getSupervisorChatReadinessForAuthorizedExternal(scope,scoped("staff") as never))
     .toEqual({enabled:false,reason:"owner_access_required"});
 });
 it("fails closed on storage errors",async()=>{
   expect(await getSupervisorChatReadinessForAuthorizedExternal(scope,scoped("owner","ai_messages") as never))
     .toEqual({enabled:false,reason:"storage_unavailable"});
 });
});
