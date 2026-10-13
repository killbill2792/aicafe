import {describe,expect,it,vi,beforeEach,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
import {trustedToastOrigin,ToastApiError,createToastClient} from "./client";
import {encryptToken} from "@/lib/security/tokenCrypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
const key=Buffer.alloc(32,7).toString("base64");
beforeEach(()=>{process.env.TOKEN_ENCRYPTION_KEY=key;process.env.TOAST_ALLOWED_API_HOSTS="ws-api.toasttab.com";});
afterEach(()=>{vi.unstubAllGlobals();});
it("rejects redirects to outside Toast, embedded credentials, non-HTTPS and unapproved Toast hosts",()=>{
  for(const input of ["https://evil.com","http://ws-api.toasttab.com","https://a@ws-api.toasttab.com",
    "https://ws-api.toasttab.com/secret","https://unapproved.toasttab.com"])
    expect(()=>trustedToastOrigin(input)).toThrow(ToastApiError);
  expect(trustedToastOrigin("https://ws-api.toasttab.com")).toBe("https://ws-api.toasttab.com");
});
function fakeDB(){
  const row={api_origin:"https://ws-api.toasttab.com",client_id:"test-id",
    client_secret_enc:encryptToken("test-secret"),
    bearer_token_enc:null as string|null,bearer_expires_at:null as string|null};
  let logins=0;let responses=0;
  const thenable=(data:unknown)=>({maybeSingle:async()=>({data,error:null}),
    then:(ok:(v:unknown)=>unknown)=>Promise.resolve({data,error:null}).then(ok)});
  const db={
    from:(table:string)=>({
      select:()=>({eq:()=>({neq:()=>thenable(row),eq:()=>thenable({verified_at:"2026-10-12T00:00:00Z"})})}),
      update:(value:Record<string,unknown>)=>({eq:async()=>{if(table==="toast_api_credentials")Object.assign(row,value);return {error:null};}}),
    }),
    rpc:async()=>({data:true,error:null}),
  } as unknown as SupabaseClient;
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
    if(url.includes("/authentication/")){logins++;return new Response(JSON.stringify({token:{accessToken:"access",expiresIn:3600}}),{status:200});}
    responses++;return new Response(JSON.stringify([{guid:"x"}]),{status:200});
  }));
  return {db,counts:()=>({logins,responses})};
}
describe("Toast token cache and read-only client",()=>{
  it("authenticates once and reuses encrypted persisted token for subsequent reads",async()=>{
    const {db,counts}=fakeDB();
    const client=createToastClient(db,"00000000-0000-4000-8000-000000000001");
    const guid="00000000-0000-4000-8000-000000000002";
    await client.request("/labor/v1/employees",guid,z.array(z.unknown()),{allowUnverified:true});
    await client.request("/labor/v1/employees",guid,z.array(z.unknown()),{allowUnverified:true});
    expect(counts()).toEqual({logins:1,responses:2});
  });
});
