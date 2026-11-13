import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
 owner:vi.fn(),account:vi.fn(),dbFrom:vi.fn(),cookies:vi.fn(),
 exchange:vi.fn(),identity:vi.fn(),fetch:vi.fn(),encrypt:vi.fn(),decrypt:vi.fn()
}));
const OWNER={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const ACCOUNT={id:"33333333-3333-4333-8333-333333333333",...OWNER,
 provider:"gmail",provider_subject:"google-subject",email:"owner@example.com",
 granted_scopes:["https://www.googleapis.com/auth/gmail.modify"],
 enabled_operations:["read","draft","send","organize"],status:"active",generation:4};
vi.mock("@/lib/connectors/registry.server",()=>({
 requireConnectorOwner:mocks.owner,
 getConnectorAccount:mocks.account,
 digest:(value:string)=>"sha256-"+value,
 allowsGmail:(account:typeof ACCOUNT|null,operation:string)=>Boolean(account?.status==="active"&&
  account.enabled_operations.includes(operation)&&
  account.granted_scopes.includes("https://www.googleapis.com/auth/gmail.modify"))
}));
vi.mock("@/lib/connectors/crypto.server",()=>({
 encryptToken:mocks.encrypt,decryptToken:mocks.decrypt
}));
vi.mock("next/headers",()=>({cookies:mocks.cookies}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:mocks.dbFrom})}));
vi.mock("@/lib/connectors/gmail/oauth.server",()=>({
 GOOGLE_MODIFY_SCOPE:"https://www.googleapis.com/auth/gmail.modify",
 oauthConfig:()=>({clientId:"test-client",clientSecret:"test-secret",
  redirectUri:"http://localhost:3000/api/connectors/gmail/callback"}),
 newOAuthChallenge:()=>({state:"safe-random-state",verifier:"pkce-secret",challenge:"sha256-challenge"}),
 authorizationUrl:(state:string)=>"https://accounts.google.com/o/oauth2/v2/auth?state="+encodeURIComponent(state),
 exchangeCode:mocks.exchange,
 verifiedGoogleMailbox:mocks.identity
}));
import {GET as connect} from "./connect/route";
import {GET as callback} from "./callback/route";
import {GET as status} from "./status/route";
import {POST as disconnect} from "./disconnect/route";

function query(table:string){
 const q:{
   insert:ReturnType<typeof vi.fn>;update:ReturnType<typeof vi.fn>;
   upsert:ReturnType<typeof vi.fn>;delete:ReturnType<typeof vi.fn>;
   select:ReturnType<typeof vi.fn>;eq:ReturnType<typeof vi.fn>;
   is:ReturnType<typeof vi.fn>;gt:ReturnType<typeof vi.fn>;
   maybeSingle:ReturnType<typeof vi.fn>;single:ReturnType<typeof vi.fn>;error:null
 }={
   insert:vi.fn(async()=>({error:null})),
   update:vi.fn(()=>q),upsert:vi.fn(()=>q),delete:vi.fn(()=>q),
   select:vi.fn(()=>q),eq:vi.fn(()=>q),is:vi.fn(()=>q),gt:vi.fn(()=>q),
   maybeSingle:vi.fn(async()=>({data:table==="connector_oauth_states"?
     {pkce_verifier_enc:"cipher-state"}:{id:ACCOUNT.id},error:null})),
   single:vi.fn(async()=>({data:{id:ACCOUNT.id,generation:5},error:null})),
   error:null
 };
 if(table==="connector_credentials"){
  q.upsert=vi.fn(async()=>({error:null}));
  q.maybeSingle=vi.fn(async()=>({data:{refresh_token_enc:"cipher-refresh"},error:null}));
 }
 return q;
}
const browserUrl="http://localhost:3000/api/connectors/gmail/";
beforeEach(()=>{
 vi.resetAllMocks();
 mocks.owner.mockResolvedValue(OWNER);
 mocks.account.mockResolvedValue(ACCOUNT);
 mocks.cookies.mockResolvedValue({get:()=>({value:"safe-random-state"})});
 mocks.encrypt.mockImplementation((text:string)=>"encrypted:"+text);
 mocks.decrypt.mockImplementation((text:string)=>text.startsWith("encrypted:")?text.slice(10):"fake-refresh");
 mocks.dbFrom.mockImplementation(query);
 mocks.exchange.mockResolvedValue({access_token:"secret-access",refresh_token:"secret-refresh",
  scope:"openid email https://www.googleapis.com/auth/gmail.modify",expires_in:3600});
 mocks.identity.mockResolvedValue({subject:"google-subject",email:"owner@example.com"});
 mocks.fetch.mockResolvedValue({ok:true});
 vi.stubGlobal("fetch",mocks.fetch);
});
describe("Task 11 Gmail connector routes (fake Google, verified owner)",()=>{
 it("connects with one click and writes scoped one-use PKCE state, never a browser token",async()=>{
   const response=await connect(new Request(browserUrl+"connect"));
   expect(response.status).toBe(307);
   expect(response.headers.get("location")).toContain("accounts.google.com");
   expect(response.headers.get("location")).not.toContain("pkce-secret");
   expect(response.headers.get("set-cookie")).toContain("HttpOnly");
   expect(mocks.dbFrom).toHaveBeenCalledWith("connector_oauth_states");
   const q=mocks.dbFrom.mock.results.find(x=>x.value?.insert)?.value;
   const row=q.insert.mock.calls[0][0] as Record<string,unknown>;
   expect(row).toMatchObject({business_id:OWNER.businessId,owner_user_id:OWNER.ownerUserId,
    pkce_verifier_enc:"encrypted:pkce-secret"});
   expect(String(row.state_digest)).not.toContain("secret-access");
 });
 it("rejects mismatched OAuth cookie without exchanging a code or changing a connection",async()=>{
   const res=await callback(new Request(browserUrl+"callback?state=attacker&code=fake"));
   expect(res.status).toBe(307);
   expect(res.headers.get("location")).toContain("authorization_cancelled");
   expect(mocks.exchange).not.toHaveBeenCalled();
   expect(mocks.dbFrom).not.toHaveBeenCalled();
 });
 it("binds successful callback to the same owner, stores encrypted tokens, and verifies Google mailbox",async()=>{
   mocks.account.mockResolvedValue(null);
   const res=await callback(new Request(browserUrl+"callback?state=safe-random-state&code=one-time-code"));
   expect(res.headers.get("location")).toContain("connected=1");
   expect(mocks.exchange).toHaveBeenCalledWith("one-time-code","fake-refresh");
   expect(mocks.identity).toHaveBeenCalledWith("secret-access");
   const credentials=mocks.dbFrom.mock.results.find(x=>x.value?.upsert?.mock?.calls?.length &&
      x.value?.upsert?.mock?.calls?.[0]?.[0]?.access_token_enc)?.value;
   expect(credentials).toBeTruthy();
   expect(credentials.upsert.mock.calls[0][0]).toMatchObject({
     access_token_enc:"encrypted:secret-access",refresh_token_enc:"encrypted:secret-refresh"});
   expect(res.headers.get("location")).not.toContain("secret-access");
 });
 it("status cannot leak credentials and shows capabilities from bound owner grants",async()=>{
   const res=await status();
   const data=await res.json() as {email:string;status:string;permissions:Record<string,boolean>};
   expect(data.email).toBe("owner@example.com");
   expect(data.status).toBe("active");
   expect(data.permissions).toEqual({read:true,draft:true,send:true,organize:true});
   expect(JSON.stringify(data)).not.toContain("secret");
   expect(res.headers.get("cache-control")).toBe("no-store");
 });
 it("blocks cross-origin disconnect before any owner/database/provider access",async()=>{
   const res=await disconnect(new Request(browserUrl+"disconnect",
     {method:"POST",headers:{origin:"https://evil.example"}}));
   expect(res.status).toBe(403);
   expect(mocks.owner).not.toHaveBeenCalled();
   expect(mocks.fetch).not.toHaveBeenCalled();
 });
 it("revokes local access before provider refresh-token revocation, preserving messages",async()=>{
   const res=await disconnect(new Request(browserUrl+"disconnect",
     {method:"POST",headers:{origin:"http://localhost:3000"}}));
   expect(res.status).toBe(200);
   expect(await res.json()).toMatchObject({status:"disconnected",dataPreserved:true});
   expect(mocks.fetch).toHaveBeenCalledTimes(1);
   expect(mocks.fetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
   const calls=mocks.dbFrom.mock.calls.map(x=>x[0]);
   expect(calls).toEqual(["connector_accounts","connector_credentials","connector_credentials","connector_accounts"]);
   const body=await res.clone().text().catch(()=>"");
   expect(body).not.toContain("fake-refresh");
 });
 it("keeps local access denied when Google's revocation fails, rather than pretending disconnect succeeded",async()=>{
   mocks.fetch.mockResolvedValue({ok:false});
   const res=await disconnect(new Request(browserUrl+"disconnect",
     {method:"POST",headers:{origin:"http://localhost:3000"}}));
   expect(res.status).toBe(503);
   expect(await res.json()).toMatchObject({status:"revoking",error:"revoke_pending"});
 });
});
