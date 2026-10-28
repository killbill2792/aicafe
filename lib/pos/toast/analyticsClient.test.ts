import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {createToastAnalyticsClient} from "./analyticsClient";
import {encryptToken} from "@/lib/security/tokenCrypto";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",g="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture(){
 const row={api_origin:"https://ws-api.toasttab.com",client_id:"analytics-client",client_secret_enc:encryptToken("secret"),
  management_group_guid:g,bearer_token_enc:null,bearer_expires_at:null,verified_at:null};
 const rpc=vi.fn(async(name:string)=>({data:name==="toast_claim_auth_lease"?"lease":name==="toast_claim_era_request"?true:null,error:null}));
 const db={rpc,from(){let patch:object|null=null;
  const q={select(){return q;},eq(){return q;},update(p:object){patch=p;return q;},
   async maybeSingle(){if(patch)Object.assign(row,patch);return {data:row,error:null};},
   then(ok:(v:unknown)=>unknown){if(patch)Object.assign(row,patch);return Promise.resolve({data:row,error:null}).then(ok);}};return q;}};
 return {row,db:db as unknown as SupabaseClient,rpc};
}
beforeEach(()=>{vi.stubEnv("TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,9).toString("base64"));vi.stubEnv("TOAST_ALLOWED_API_HOSTS","ws-api.toasttab.com");});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it("login succeeds but a real ERA 403 never sets verified_at",async()=>{
 const f=fixture();
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("/authentication/")?
  new Response(JSON.stringify({token:{accessToken:"bearer",expiresIn:3600}})):
  new Response("",{status:403})));
 await expect(createToastAnalyticsClient(f.db,b,Date.now()+20000).test(g,"2026-10-20"))
  .rejects.toMatchObject({category:"missing_permissions"});
 expect(f.row.bearer_token_enc).toBeTruthy();expect(f.row.verified_at).toBeNull();
 expect(f.rpc).toHaveBeenCalledWith("toast_release_auth_lease",{p_business_id:b,p_lease_nonce:"lease"});
});
it("a genuine ERA 202 proves report access, including when the GUID is not ready",async()=>{
 const f=fixture(),calls:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>{calls.push(url);return url.includes("/authentication/")?
  new Response(JSON.stringify({token:{accessToken:"bearer",expiresIn:3600}})):
  new Response("",{status:202});}));
 await createToastAnalyticsClient(f.db,b,Date.now()+20000).test(g,"2026-10-20");
 expect(f.row.verified_at).toBeTruthy();expect(calls.some(p=>p.endsWith("/era/v1/metrics/day"))).toBe(true);
});
it("bad Analytics login cannot create false verification",async()=>{
 const f=fixture();vi.stubGlobal("fetch",vi.fn(async()=>new Response("",{status:401})));
 await expect(createToastAnalyticsClient(f.db,b,Date.now()+20000).test(g,"2026-10-20"))
  .rejects.toMatchObject({category:"authentication"});
 expect(f.row.verified_at).toBeNull();
});

it("diagnostic GET waits for one exhausted ERA budget slot and retries",async()=>{
 const f=fixture(),original=f.rpc.getMockImplementation()!;
 let denied=true;
 f.rpc.mockImplementation(async(name:string)=>{
  if(name==="toast_claim_era_request"&&denied){denied=false;return {data:false,error:null};}
  return original(name);
 });
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("/authentication/")?
  new Response(JSON.stringify({token:{accessToken:"bearer",expiresIn:3600}})):
  new Response(JSON.stringify([{netSalesAmount:42}]),{status:200})));
 const result=await createToastAnalyticsClient(f.db,b,Date.now()+20000,true)
  .getRaw("/era/v1/restaurants-information");
 expect(result.status).toBe(200);
 expect(denied).toBe(false);
 expect(f.rpc.mock.calls.filter(([name])=>name==="toast_claim_era_request")).toHaveLength(2);
});


it("retains an ERA result as immutable raw evidence and six typed measurements",async()=>{
 const f=fixture();
 const writes:Array<{table:string;data:unknown;options:unknown}>=[];
 const original=f.db.from.bind(f.db);
 const db={...f.db,from(table:string){
  if(table==="toast_raw_records"||table==="toast_analytics_results")
   return {upsert:async(data:unknown,options:unknown)=>{
    writes.push({table,data,options});return {error:null};
   }};
  return original(table);
 }} as unknown as SupabaseClient;
 const report="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 const row={restaurantGuid:g,businessDate:"20261020",
  netSalesAmount:10.25,ordersCount:2,discountAmount:1,
  refundAmount:0,voidOrdersCount:0,voidOrdersAmount:null};
 await createToastAnalyticsClient(db,b,Date.now()+20000).persistDay(g,"2026-10-20",report,row);
 expect(writes).toHaveLength(2);
 expect(writes[0].table).toBe("toast_raw_records");
 expect(writes[1].table).toBe("toast_analytics_results");
 expect(writes[1].data).toEqual(expect.arrayContaining([
  expect.objectContaining({metric:"net_sales_cents",value_numeric:1025})
 ]));
 await expect(createToastAnalyticsClient(db,b,Date.now()+20000).persistDay(
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd","2026-10-20",report,row))
  .rejects.toMatchObject({category:"invalid_response"});
 expect(writes).toHaveLength(2);
});
