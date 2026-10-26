import {beforeEach,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const f=vi.hoisted(()=>({authorized:true,rpc:vi.fn(),vision:vi.fn(),queries:[] as [string,string][]}));
vi.mock("@/lib/pos/toast/ownerAccess",()=>({authorizeToastOwner:async()=>{
 if(!f.authorized)return null;
 return {from(){const q={select(){return q;},eq(k:string,v:string){f.queries.push([k,v]);return q;},not(){return q;},maybeSingle:async()=>({data:{restaurant_guid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},error:null})};return q;}};
}}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({rpc:f.rpc})}));
vi.mock("@/lib/ai/prompts/toastSummaryReading",()=>({readToastSummaryPhoto:f.vision}));
import {POST} from "./route";
import {POST as preview} from "./preview/route";
const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurantGuid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const values={date:"2026-10-20",netSalesCents:123456,ordersCount:210,discountsCents:null,refundsCents:null,voidsCount:null};
const request=(payload:object)=>new Request("http://localhost/api/pos/toast/summary",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
beforeEach(()=>{vi.stubEnv("TOAST_SETUP_ENABLED","true");f.authorized=true;f.rpc.mockReset();f.rpc.mockResolvedValue({error:null});f.vision.mockReset();f.queries=[];});
it("saves only confirmed integer cents through the signed owner RPC",async()=>{
 expect((await POST(request({businessId,restaurantGuid,...values,source:"typed"}))).status).toBe(200);
 expect(f.rpc).toHaveBeenCalledWith("toast_save_owner_summary",expect.objectContaining({p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_net:123456,p_orders:210}));
});
it("neither a non-owner nor a fractional-cent payload reaches the writer",async()=>{
 f.authorized=false;expect((await POST(request({businessId,restaurantGuid,...values,source:"typed"}))).status).toBe(403);
 f.authorized=true;expect((await POST(request({businessId,restaurantGuid,...values,netSalesCents:1.25,source:"typed"}))).status).toBe(400);
 expect(f.rpc).not.toHaveBeenCalled();
});
it("CSV and photo previews produce identical drafts without saving anything",async()=>{
 const csv=await preview(request({businessId,restaurantGuid,date:values.date,locale:"es",source:"csv",content:'Date;Net sales;Total orders\n2026-10-20;1234,56;210'}));
 expect(csv.status).toBe(200);const expected=await csv.json();
 f.vision.mockResolvedValue({days:[values]});
 const photo=await preview(request({businessId,restaurantGuid,date:values.date,locale:"ar",source:"photo",content:"data:image/jpeg;base64,YQ=="}));
 expect(await photo.json()).toEqual(expected);expect(f.rpc).not.toHaveBeenCalled();
 expect(f.queries).toContainEqual(["business_id",businessId]);expect(f.queries).toContainEqual(["restaurant_guid",restaurantGuid]);
});
it("never sends an unauthorized photo to vision",async()=>{
 f.authorized=false;
 expect((await preview(request({businessId,restaurantGuid,date:values.date,locale:"en",source:"photo",content:"data:image/jpeg;base64,YQ=="}))).status).toBe(403);
 expect(f.vision).not.toHaveBeenCalled();
});
