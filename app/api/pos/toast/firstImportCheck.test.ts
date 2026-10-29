import {beforeEach,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const mock=vi.hoisted(()=>({db:null as SupabaseClient|null}));
vi.mock("@/lib/pos/toast/ownerAccess",()=>({
 authorizeToastOwner:async()=>mock.db
}));
vi.mock("@/lib/pos/toast/client",async()=>({GUID:(await import("zod")).z.uuid()}));
import {POST} from "./first-import-check/route";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const location="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dates=["2026-10-14","2026-10-15","2026-10-16","2026-10-17",
 "2026-10-18","2026-10-19","2026-10-20"];
const post=(data:unknown)=>POST(new Request("http://localhost/api/pos/toast/first-import-check",{
 method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)
}));
beforeEach(()=>{
 vi.stubEnv("TOAST_SETUP_ENABLED","true");
 const rows=dates.map(date=>({business_date:date,restaurant_guid:location,
  import_state:"imported",coverage_complete:true,net_sales_cents:1000,order_count:2}));
 const rpc=vi.fn(async()=>({data:null,error:null}));
 const db={rpc,from(table:string){
  const q={select(){return q;},eq(){return q;},order(){return q;},
   range:async(start:number,end:number)=>({data:rows.slice(start,end+1),error:null}),
   maybeSingle:async()=>({data:{answered_at:null},error:null}),
   then:(cb:(x:unknown)=>unknown)=>Promise.resolve({data:table==="toast_location_mappings"?
     [{restaurant_guid:location,verified_at:"2026-10-10T00:00:00Z",
      toast_start_date:"2026-10-10"}]:[],error:null}).then(cb)
  };return q;
 }} as unknown as SupabaseClient;
 mock.db=db;
});
it("Looks right calls one atomic approval/clear-flags RPC for all compared days",async()=>{
 const result=await post({businessId:business,answer:"looks_right",flaggedDates:[]});
 expect(result.status).toBe(200);
 expect(mock.db!.rpc).toHaveBeenCalledWith("toast_answer_first_import_check",{
  p_business_id:business,p_answer:"looks_right",p_days:[],p_note:null
 });
});
it("Something's off passes selected day and note to atomic owner-flags RPC",async()=>{
 const result=await post({businessId:business,answer:"something_off",
  flaggedDates:["2026-10-18"],note:"Net sales is off"});
 expect(result.status).toBe(200);
 expect(mock.db!.rpc).toHaveBeenCalledWith("toast_answer_first_import_check",{
  p_business_id:business,p_answer:"something_off",
  p_days:["2026-10-18"],p_note:"Net sales is off"
 });
});
it("does not clear anything when valid comparison days are not supplied",async()=>{
 const result=await post({businessId:business,answer:"something_off",flaggedDates:[]});
 expect(result.status).toBe(400);
 expect(mock.db!.rpc).not.toHaveBeenCalled();
});
