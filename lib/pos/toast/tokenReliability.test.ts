import {describe,expect,it,vi,beforeEach,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
import {toastRetryAt,ToastApiError,trustedToastOrigin,createToastClient} from "./client";
import {encryptToken} from "@/lib/security/tokenCrypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
beforeEach(()=>{
 process.env.TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,2).toString("base64");
 process.env.TOAST_ALLOWED_API_HOSTS="ws-api.toasttab.com";
});
afterEach(()=>vi.unstubAllGlobals());
function fixture(initial:{bearer?:string;expiresAt?:string;retryAt?:string}={}) {
 const row={api_origin:"https://ws-api.toasttab.com",client_id:"client",
 client_secret_enc:encryptToken("safe-secret"),bearer_token_enc:initial.bearer?encryptToken(initial.bearer):null as string|null,
 bearer_expires_at:initial.expiresAt??null as string|null,retry_after:initial.retryAt??null as string|null};
 let lease:string|null=null;
 let logins=0,reads=0;
 const db={
  from:(table:string)=>({
   select:()=>({eq:()=>({
     neq:()=>({maybeSingle:async()=>({data:row,error:null})}),
     eq:()=>({maybeSingle:async()=>({data:{verified_at:"2026-10-01T00:00:00Z"},error:null})})
   })}),
   update:(updates:Record<string,unknown>)=>({eq:async()=>{if(table==="toast_api_credentials")Object.assign(row,updates);return {error:null};}})
  }),
  rpc:async(name:string,args:Record<string,unknown>)=>{
   if(name==="toast_claim_auth_lease"){
    if(lease)return {data:null,error:null};
    lease="cccccccc-cccc-4ccc-8ccc-cccccccccccc";return {data:lease,error:null};
   }
   if(name==="toast_commit_auth_token"){
    if(args.p_lease_nonce!==lease)return {data:false,error:null};
    row.bearer_token_enc=String(args.p_ciphertext);
    row.bearer_expires_at=String(args.p_expires_at);
    lease=null;return {data:true,error:null};
   }
   if(name==="toast_release_auth_lease"){
    if(args.p_lease_nonce===lease)lease=null;
    return {data:null,error:null};
   }
   if(name==="toast_invalidate_token_if_match"){
    if(args.p_expected_ciphertext===row.bearer_token_enc){
      row.bearer_token_enc=null;row.bearer_expires_at=null;
      return {data:true,error:null};
    }
    return {data:false,error:null};
   }
   return {data:null,error:{code:"no_rpc"}};
  }
 } as unknown as SupabaseClient;
 function install(mode:"ok"|"auth429"|"unavailable"="ok"){
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
   if(url.includes("/authentication/")){
    logins++;
    if(mode==="auth429")return new Response("",{status:429,headers:{"Retry-After":"900"}});
    return new Response(JSON.stringify({token:{accessToken:"token",expiresIn:86400}}),{status:200});
   }
   reads++;
   if(mode==="unavailable")return new Response("",{status:503});
   return new Response(JSON.stringify([]),{status:200});
  }));
 }
 return {db,row,install,counts:()=>({logins,reads})};
}
const request=(db:SupabaseClient)=>createToastClient(db,business)
 .request("/labor/v1/employees",restaurant,z.array(z.unknown()),{allowUnverified:true});
describe("Toast rate limits and token reuse",()=>{
 it("refuses to reauthenticate after a 15-minute auth Retry-After across requests",async()=>{
  const f=fixture();f.install("auth429");
  await expect(request(f.db)).rejects.toMatchObject({category:"rate_limited"});
  expect(f.row.retry_after).toBeTruthy();
  await expect(request(f.db)).rejects.toMatchObject({category:"rate_limited"});
  expect(f.counts()).toEqual({logins:1,reads:0});
 });
 it("reuses an unexpired encrypted token without any auth call",async()=>{
  const f=fixture({bearer:"token",expiresAt:new Date(Date.now()+3600000).toISOString()});f.install();
  await request(f.db);
  expect(f.counts()).toEqual({logins:0,reads:1});
 });
 it("renews expired tokens once on first read",async()=>{
  const f=fixture({bearer:"old",expiresAt:new Date(Date.now()-30000).toISOString()});f.install();
  await request(f.db);await request(f.db);
  expect(f.counts()).toEqual({logins:1,reads:2});
 });
 it("does not pretend transient HTTP 503 is an empty set",async()=>{
  const f=fixture({bearer:"token",expiresAt:new Date(Date.now()+3600000).toISOString()});f.install("unavailable");
  await expect(request(f.db)).rejects.toMatchObject({category:"unavailable",status:503});
 });
 it("does not truncate Retry-After or accept unknown hosts",()=>{
  const r=new Response("",{status:429,headers:{"Retry-After":"900"}});
  expect(Date.parse(toastRetryAt(r,1000))).toBe(901000);
  expect(()=>trustedToastOrigin("https://fake.toasttab.com","ws-api.toasttab.com")).toThrow(ToastApiError);
 });
});
