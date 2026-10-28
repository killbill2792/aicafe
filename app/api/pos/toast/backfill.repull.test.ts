import {beforeEach,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const fixture=vi.hoisted(()=>({db:null as SupabaseClient|null}));
vi.mock("@/lib/pos/toast/client",async()=>({GUID:(await import("zod")).z.uuid()}));
vi.mock("@/lib/pos/toast/ownerAccess",()=>({
 authorizeToastOwner:async()=>fixture.db
}));
import {POST} from "./backfill/route";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const g="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const post=(body:unknown)=>POST(new Request("http://localhost/api/pos/toast/backfill",{
 method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
}));
beforeEach(()=>{
 vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
 const q={select:()=>q,eq:()=>q,then:(cb:(v:unknown)=>unknown)=>Promise.resolve({
  data:[{restaurant_guid:g,verified_at:"2026-10-01",toast_time_zone:"America/Los_Angeles"}],error:null
 }).then(cb)};
 const rpc=vi.fn(async()=>({data:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",error:null}));
 fixture.db={from:()=>q,rpc} as unknown as SupabaseClient;
});
it("queues a genuinely new one-day repull and does not fall back to old range progress",async()=>{
 const response=await post({businessId:b,from:"2026-10-20",to:"2026-10-20",repull:true});
 expect(response.status).toBe(202);
 expect(fixture.db!.rpc).toHaveBeenCalledWith("toast_queue_owner_repull",{
  p_business_id:b,p_restaurant_guid:g,p_date:"2026-10-20"
 });
});
it("rejects an unsafe multi-day forced repull",async()=>{
 const response=await post({businessId:b,from:"2026-10-19",to:"2026-10-20",repull:true});
 expect(response.status).toBe(400);
 expect(fixture.db!.rpc).not.toHaveBeenCalled();
});
