import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const active=vi.hoisted(()=>({
  userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  permittedBusiness:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role:"owner" as "owner"|"manager"|"none",
  demo:false, signedIn:true,adminCalls:0,
}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:async()=>({
    auth:{getUser:async()=>({data:{user:active.signedIn?{id:active.userId}:null},error:null})},
    from:(table:string)=> {
      let requestedBusiness="";
      const chain={
        select:()=>chain,eq:(column:string,value:string)=>{
          if(column==="business_id"||column==="id")requestedBusiness=value;
          return chain;
        },
        maybeSingle:async()=>({data:table==="memberships"&&
          requestedBusiness===active.permittedBusiness&&active.role==="owner"?{role:"owner"}:null,error:null}),
        single:async()=>({data:{is_demo:active.demo},error:null}),
      };
      return chain;
    }
  })
}));
vi.mock("@/lib/supabase/admin",()=>({
  createAdminSupabaseClient:()=>{active.adminCalls++;return {adminClient:true};}
}));
import {authorizeToastOwner} from "./ownerAccess";
const business="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
beforeEach(()=>{active.role="owner";active.demo=false;active.signedIn=true;active.adminCalls=0;});
describe("Toast credential owner authorization",()=>{
  it("allows real business owners only",async()=>{
    expect(await authorizeToastOwner(business)).toEqual({adminClient:true});
    expect(active.adminCalls).toBe(1);
  });
  it("does not give service role to signed-out users",async()=>{
    active.signedIn=false;expect(await authorizeToastOwner(business)).toBeNull();
    expect(active.adminCalls).toBe(0);
  });
  it("does not give service role to managers",async()=>{
    active.role="manager";expect(await authorizeToastOwner(business)).toBeNull();
    expect(active.adminCalls).toBe(0);
  });
  it("does not give service role for a different business",async()=>{
    expect(await authorizeToastOwner("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeNull();
    expect(active.adminCalls).toBe(0);
  });
  it("does not allow mutations against shared demo cafe",async()=>{
    active.demo=true;expect(await authorizeToastOwner(business)).toBeNull();
    expect(active.adminCalls).toBe(0);
  });
});
