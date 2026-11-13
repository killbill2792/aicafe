import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const deps=vi.hoisted(()=>({getAccount:vi.fn(),dbFrom:vi.fn(),tokenRequest:vi.fn()}));
vi.mock("@/lib/connectors/registry.server",async()=>{
  const real=await vi.importActual<typeof import("@/lib/connectors/registry.server")>("@/lib/connectors/registry.server");
  return {...real,getConnectorAccount:deps.getAccount};
});
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:deps.dbFrom})}));
vi.mock("@/lib/connectors/crypto.server",()=>({decryptToken:()=> "test-access",encryptToken:()=> "encrypted"}));
vi.mock("./oauth.server",()=>({tokenRequest:deps.tokenRequest,GOOGLE_MODIFY_SCOPE:"https://www.googleapis.com/auth/gmail.modify"}));
import {performGmailEffect,gmailMime,gmailRfcId,reconcileGmailReceipt,safeMessage,type GmailEffect} from "./provider.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222"};
const proposal="33333333-3333-4333-8333-333333333333",effectHash="e".repeat(64);
const account={id:"44444444-4444-4444-8444-444444444444",...scope,provider:"gmail" as const,
 provider_subject:"sub",email:"owner@example.com",granted_scopes:["https://www.googleapis.com/auth/gmail.modify"],
 enabled_operations:["read","draft","send","organize"],status:"active" as const,generation:1};
const effect:GmailEffect={accountId:account.id,generation:1,from:account.email,operation:"send",action:null,
 to:["supplier@example.net"],cc:[],bcc:[],subject:"Order confirmation",body:"Confirmed. Thanks.",
 messageId:null,threadId:null,labelId:null,labelName:null};
const credentials={generation:1,access_token_enc:"encrypted",refresh_token_enc:"encrypted",
 token_expires_at:new Date(Date.now()+3600000).toISOString()};
function db(receipt?:Record<string,unknown>,duplicate=false){
 const writes:Array<{table:string;operation:string;data:unknown}>=[];
 deps.dbFrom.mockImplementation((table:string)=>{
   const chain={
     select:vi.fn(()=>chain),eq:vi.fn(()=>chain),in:vi.fn(()=>chain),
     update:vi.fn((data:unknown)=>{writes.push({table,operation:"update",data});return chain;}),
     insert:vi.fn((data:unknown)=>{writes.push({table,operation:"insert",data});return chain;}),
     maybeSingle:vi.fn(async()=>{
       if(table==="connector_credentials")return {data:credentials,error:null};
       if(table==="connector_provider_receipts"){
         if(duplicate&&writes.some(x=>x.operation==="insert"))
           return {data:null,error:{code:"23505"}};
         if(receipt&&!writes.some(x=>x.operation==="insert"))return {data:receipt,error:null};
         return {data:{id:"55555555-5555-4555-8555-555555555555"},error:null};
       }
       return {data:null,error:null};
     })
   };
   return chain;
 });
 return writes;
}
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();deps.getAccount.mockResolvedValue(account);});
describe("Gmail provider proof and no duplicate sends",()=>{
 it("generates a stable RFC ID and MIME without leaking credentials",()=>{
   const mid=gmailRfcId(proposal,account.email);
   expect(mid).toBe("<aicafe-"+proposal+"@example.com>");
   const raw=gmailMime(effect,mid,null);
   const decoded=Buffer.from(raw,"base64url").toString("utf8");
   expect(decoded).toContain("To: supplier@example.net");
   expect(decoded).toContain("Message-ID: "+mid);
   expect(decoded).not.toContain("test-access");
 });
 it("sends once only after reserving durable receipt, then verifies Gmail SENT postcondition",async()=>{
   const writes=db();
   const posted:{raw:string}[]=[];
   const fetch=vi.fn(async(url:string,init:Record<string,unknown>)=>{
     if(url.endsWith("/messages/send")){
       const parsed=JSON.parse(String(init.body)) as {raw:string};
       posted.push(parsed);
       return {ok:true,status:200,json:async()=>({id:"provider-message-123"})};
     }
     if(url.includes("/messages/provider-message-123")){
       return {ok:true,status:200,json:async()=>({id:"provider-message-123",labelIds:["SENT"],
         payload:{headers:[{name:"Message-ID",value:gmailRfcId(proposal,account.email)}]}})};
     }
     throw new Error("unexpected provider URL");
   });
   vi.stubGlobal("fetch",fetch);
   const result=await performGmailEffect(scope,effect,proposal,effectHash);
   expect(result.providerAccepted).toBe(true);
   expect(result.recipientDeliveryUnverified).toBe(true);
   expect(posted).toHaveLength(1);
   expect(writes.map(x=>x.operation)).toEqual(["insert","update"]);
   expect((writes[1].data as {state:string}).state).toBe("verified");
 });
 it("refuses a second provider call after uncertain send reservation",async()=>{
   const writes=db(undefined,true);
   const fetch=vi.fn();
   vi.stubGlobal("fetch",fetch);
   await expect(performGmailEffect(scope,effect,proposal,effectHash))
     .rejects.toThrow("gmail_effect_already_reserved_reconcile_first");
   expect(writes.map(x=>x.operation)).toEqual(["insert"]);
   expect(fetch).not.toHaveBeenCalled();
 });
 it("prevents send if account was revoked after credentials were loaded",async()=>{
   db();deps.getAccount.mockResolvedValueOnce(account)
     .mockResolvedValueOnce({...account,status:"revoking",generation:2});
   const fetch=vi.fn();
   vi.stubGlobal("fetch",fetch);
   await expect(performGmailEffect(scope,effect,proposal,effectHash))
     .rejects.toThrow("gmail_connection_revoked_before_send");
   expect(fetch).not.toHaveBeenCalled();
 });
 it("does not treat a created Gmail label as verified until exact provider readback",async()=>{
   const writes=db();
   const label={...effect,operation:"create_label" as const,labelName:"Suppliers"};
   const fetch=vi.fn(async(url:string,init:Record<string,unknown>)=>{
     if(url.endsWith("/labels")&&init.method==="POST")
       return {ok:true,status:200,json:async()=>({id:"Label_42"})};
     if(url.endsWith("/labels/Label_42"))
       return {ok:true,status:200,json:async()=>({id:"Label_42",name:"Suppliers"})};
     throw Error("unexpected label request");
   });
   vi.stubGlobal("fetch",fetch);
   const result=await performGmailEffect(scope,label,proposal,effectHash);
   expect(result.providerAccepted).toBe(true);
   expect(fetch).toHaveBeenCalledTimes(2);
   expect(writes.map(x=>x.operation)).toEqual(["insert","update"]);
 });
 it("treats mail body as bounded evidence, never an instruction for a provider effect",()=>{
   const m=safeMessage({id:"message123",snippet:"text",
    payload:{headers:[{name:"Subject",value:"Invoice"},{name:"Authorization",value:"secret"}],
      mimeType:"text/plain",body:{data:Buffer.from("Invoice 123").toString("base64url")}}});
   expect(m.body).toBe("Invoice 123");
   expect(m.headers).toEqual({subject:"Invoice"});
 });
 it("reconciles by Gmail SENT + exact stable Message-ID, without invoking send",async()=>{
   const rfc=gmailRfcId(proposal,account.email);
   const writes=db({id:"55555555-5555-4555-8555-555555555555",
     account_id:account.id,account_generation:1,state:"uncertain",rfc_message_id:rfc});
   const fetch=vi.fn(async(url:string)=>{
     if(url.includes("/messages?q="))return {ok:true,status:200,json:async()=>({
       messages:[{id:"found-provider-message"}]})};
     if(url.includes("/messages/found-provider-message"))return {ok:true,status:200,json:async()=>({
       id:"found-provider-message",labelIds:["SENT"],payload:{headers:[{name:"Message-ID",value:rfc}]}})};
     throw Error("Unexpected API");
   });
   vi.stubGlobal("fetch",fetch);
   const verified=await reconcileGmailReceipt(scope,effect,proposal,effectHash);
   expect(verified).toBe(true);
   expect(fetch.mock.calls.some(([url])=>String(url).includes("/messages/send"))).toBe(false);
   expect((writes[0].data as {state:string}).state).toBe("verified");
 });
});
