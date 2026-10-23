import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const fake=vi.hoisted(()=>({calls:[] as string[]}));
vi.mock("@/lib/access/access.server",()=>({accessCodeHash:()=> "hash"}));
vi.mock("@/lib/supabase/admin",()=>({
 createAdminSupabaseClient:()=>({
  from:(name:string)=>({
   select:()=>({
    order:()=>({limit:async()=>({data:name==="free_access_codes"?
     [{id:"c1",code_hint:"CAFE…",duration_months:3,fixed_end_date:null,max_cafes:1000,note:null,active:true,created_at:"2026-10-23"}]:
      name==="free_access_redemptions"?[{code_id:"c1",business_id:"b1",redeemed_by:null,redeemed_at:"2026-10-23",access_end:"2027-01-23"}]:
      name==="businesses"?[{id:"b1",name:"Test"}]:[],error:null})}),
    limit:async()=>({data:[],error:null}),
   }),
  }),
  rpc:async(name:string)=>{fake.calls.push(name);return {data:{c1:750},error:null};},
  auth:{admin:{getUserById:async()=>({data:{user:{email:"owner@example.com"}}})}},
 })
}));
import {getAdminCodeConsole} from "./adminCodes.server";
describe("admin code capacity independent of paginated ledger",()=>{
 it("reports authoritative 750-redemption total when only one history row is loaded",async()=>{
  const data=await getAdminCodeConsole();
  expect(data.redemptions).toHaveLength(1);
  expect(data.codes[0].redeemed_cafes).toBe(750);
  expect(fake.calls).toContain("admin_code_redemption_counts");
 });
});
