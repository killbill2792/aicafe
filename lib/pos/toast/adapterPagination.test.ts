import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const api=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("./client",async (importOriginal)=>{
 const original=await importOriginal<typeof import("./client")>();
 return {...original,createToastClient:()=>({request:api.request})};
});
import {createToastAdapter} from "./adapter";
import type {SupabaseClient} from "@supabase/supabase-js";
const restaurantGuid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const range={since:new Date("2026-10-10T12:00:00Z"),
 until:new Date("2026-10-10T12:10:00Z")};
const adapter=createToastAdapter({db:{} as SupabaseClient,
 businessId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",restaurantGuid});
function fakeOrder(i:number){
 const hex=i.toString(16).padStart(12,"0");
 return {guid:"00000000-0000-4000-8000-"+hex,
  modifiedDate:"2026-10-10T12:05:00Z",deleted:false,checks:[]};
}
describe("bounded Toast OrdersBulk polling page contract",()=>{
 beforeEach(()=>api.request.mockReset());
 for(const total of [50,100,250]){
  it("paginates "+total+" changes in <=100-record leases, never loses the final page",async()=>{
   api.request.mockImplementation(async(path:string)=>{
    const url=new URL(path,"https://example.test");
    const page=Number(url.searchParams.get("page"));
    const start=(page-1)*100;
    return Array.from({length:Math.max(0,Math.min(100,total-start))},
      (_,index)=>fakeOrder(start+index+1));
   });
   const seen=new Set<string>();
   let page=1,complete=false,requests=0;
   while(!complete){
    const result=await adapter.fetchModifiedOrderStatesPage(range,page);
    requests++;
    expect(result.facts.length).toBeLessThanOrEqual(100);
    for(const fact of result.facts){
      expect(seen.has(fact.orderGuid)).toBe(false);
      seen.add(fact.orderGuid);
      expect(fact.state).toBe("ambiguous"); // zero checks: never fabricated revenue
    }
    complete=!result.hasMore;
    page++;
    if(requests>5)throw Error("unexpected page loop");
   }
   expect(seen.size).toBe(total);
   expect(requests).toBe(Math.ceil(total/100)+(total%100===0?1:0));
   expect(api.request).toHaveBeenCalledTimes(requests);
  });
 }
 it("rejects invalid page numbers rather than unbounded requests",async()=>{
  await expect(adapter.fetchModifiedOrderStatesPage(range,0)).rejects.toThrow();
  await expect(adapter.fetchModifiedOrderStatesPage(range,1001)).rejects.toThrow();
  expect(api.request).not.toHaveBeenCalled();
 });
});
