import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({
  auth:vi.fn(),memberships:vi.fn(),names:vi.fn(),
}));
vi.mock("react",async importOriginal=>{
  const original=await importOriginal<typeof import("react")>();
  return {...original,cache:<T extends (...args:never[])=>unknown>(fn:T)=>{
    const values=new Map<string,ReturnType<T>>();
    return ((...args:Parameters<T>)=>{
      const key=JSON.stringify(args);
      if(!values.has(key))values.set(key,fn(...args) as ReturnType<T>);
      return values.get(key);
    }) as T;
  }};
});
vi.mock("next/headers",()=>({cookies:async()=>({
  get:()=>({value:"not-a-member"}),
})}));
vi.mock("next/navigation",()=>({redirect:()=>{throw Error("Unexpected redirect");}}));
vi.mock("next-intl/server",()=>({getLocale:async()=>"en"}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/data/fixtureSnapshot",()=>({
  getFixtureSnapshot:()=>({business:{id:"demo",name:"Demo café"}}),
}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:async()=>({
    auth:{getUser:state.auth},
    from(table:string){
      if(table==="memberships")return {
        select(){return this;},eq(){return state.memberships();},
      };
      if(table==="businesses")return {
        select(){return this;},eq(){return this;},
        maybeSingle:()=>state.names(),
      };
      throw Error("Unexpected table "+table);
    },
  }),
}));
import {getActiveBusinessId} from "./getActiveBusinessId";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getActiveCafeName} from "./getActiveCafeName";

describe("request-scoped café identity",()=>{
  it("reuses one RLS membership and one auth lookup across shell, guard and snapshot selector",async()=>{
    state.auth.mockResolvedValue({data:{user:{id:"owner-1"}},error:null});
    state.memberships.mockResolvedValue({data:[
      {business_id:"demo",businesses:{is_demo:true}},
      {business_id:"cafe-1",businesses:{is_demo:false}},
    ],error:null});
    state.names.mockResolvedValue({data:{name:"My café"},error:null});
    const [owner,active,cafeName]=await Promise.all([
      requireOwnBusiness(),getActiveBusinessId("owner-1"),getActiveCafeName(),
    ]);
    expect(owner?.id).toBe("owner-1");
    // A forged active_business_id cookie must not choose an unrelated café.
    expect(active).toBe("cafe-1");
    expect(cafeName).toBe("My café");
    expect(state.auth).toHaveBeenCalledOnce();
    expect(state.memberships).toHaveBeenCalledOnce();
    expect(state.names).toHaveBeenCalledOnce();
  });
});
