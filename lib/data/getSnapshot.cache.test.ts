import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const stat=vi.hoisted(()=>({snapshot:vi.fn(),auth:vi.fn(),active:vi.fn()}));
// Deterministic request-scope memoization adapter: one simulated server render.
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
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  auth:{getUser:stat.auth},
})}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:stat.active}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:stat.snapshot}));
vi.mock("@/lib/data/fixtureSnapshot",()=>({getFixtureSnapshot:()=>({business:{id:"demo"}})}));
import {getSnapshot} from "./getSnapshot";
describe("request-cached getSnapshot",()=>{
  it("uses one snapshot and one auth check for repeat consumers in one render",async()=>{
    stat.auth.mockResolvedValue({data:{user:{id:"owner1"}}});
    stat.active.mockResolvedValue("business1");
    stat.snapshot.mockResolvedValue({business:{id:"business1"}});
    const [home,attention]=await Promise.all([getSnapshot("today"),getSnapshot("today")]);
    expect(home).toBe(attention);
    expect(stat.snapshot).toHaveBeenCalledOnce();
    expect(stat.active).toHaveBeenCalledOnce();
    expect(stat.auth).toHaveBeenCalledOnce();
    // A different period must not reuse the wrong selected-period cost evidence.
    await getSnapshot("week");
    expect(stat.snapshot).toHaveBeenCalledTimes(2);
  });
});
