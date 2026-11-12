import {beforeEach,describe,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",threadId:"33333333-3333-4333-8333-333333333333",
 denied:false,challengeCalls:0,verifyCalls:0,revokeCalls:0,readCalls:0}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
 ConversationApiError:class extends Error{constructor(public status:number,public code:string){super(code);}},
 authenticatedConversationContext:async()=>({scope:{businessId:f.businessId,ownerUserId:f.ownerUserId},
  service:{getThread:async(id:string)=>{if(f.denied||id!==f.threadId)throw Error("thread_not_found");return {id};}}}),
}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({auth:{}})}));
vi.mock("@/lib/ai/supervisor/loop/mandates.server",()=>({
 readMandates:vi.fn(async()=>{f.readCalls++;return [{id:"mandate-id",limit_value:5}];}),
 createMandateChallenge:vi.fn(async(_scope:unknown,_client:unknown,input:unknown)=>{f.challengeCalls++;return {challengeId:"challenge-id",...input as object};}),
 verifyMandateChallenge:vi.fn(async(_scope:unknown,_client:unknown,input:unknown)=>{f.verifyCalls++;return {id:"mandate-id",verified:true};}),
 revokeMandate:vi.fn(async()=>{f.revokeCalls++;return {id:"mandate-id",revoked_at:"2026-11-11T00:00:00Z"};}),
}));
import {GET,POST} from "./route";
import {createMandateChallenge,revokeMandate,verifyMandateChallenge} from "@/lib/ai/supervisor/loop/mandates.server";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/mandates";
const params={params:Promise.resolve({threadId:f.threadId})};
function post(body:Record<string,unknown>,origin=true){
 return POST(new Request(url,{method:"POST",headers:{"content-type":"application/json",
  ...(origin?{origin:"http://localhost:3000"}:{})},body:JSON.stringify(body)}),params);
}
beforeEach(()=>{f.denied=false;f.challengeCalls=0;f.verifyCalls=0;f.revokeCalls=0;f.readCalls=0;
 vi.clearAllMocks();});
describe("owner-scoped mandate route",()=>{
 it("reads only the authenticated thread owner's café mandates",async()=>{
  const response=await GET(new Request(url),params);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({mandates:[{id:"mandate-id"}]});
  expect(f.readCalls).toBe(1);
 });
 it("requires same-origin before starting a phone challenge",async()=>{
  const response=await post({action:"challenge",factorId:"55555555-5555-4555-8555-555555555555",
   limitValue:5,expiresAt:"2026-12-01T00:00:00Z"},false);
  expect(response.status).toBe(403);
  expect(f.challengeCalls).toBe(0);
 });
 it("rejects a cap other than five at the API boundary",async()=>{
  const response=await post({action:"challenge",factorId:"55555555-5555-4555-8555-555555555555",
   limitValue:4,expiresAt:"2026-12-01T00:00:00Z"});
  expect(response.status).toBe(422);
  expect(f.challengeCalls).toBe(0);
 });
 it("binds a challenge to the selected owner cap and expiry",async()=>{
  const response=await post({action:"challenge",factorId:"55555555-5555-4555-8555-555555555555",
   limitValue:5,expiresAt:"2026-12-01T00:00:00Z"});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({challenge:{challengeId:"challenge-id",limitValue:5}});
  expect(vi.mocked(createMandateChallenge)).toHaveBeenCalledWith(
   {businessId:f.businessId,ownerUserId:f.ownerUserId},expect.anything(),expect.objectContaining({limitValue:5}));
 });
 it("forwards a code only to the server MFA verifier",async()=>{
  const response=await post({action:"verify",challengeId:"44444444-4444-4444-8444-444444444444",code:"123456"});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({mandate:{id:"mandate-id"}});
  expect(vi.mocked(verifyMandateChallenge)).toHaveBeenCalledWith(
   {businessId:f.businessId,ownerUserId:f.ownerUserId},expect.anything(),
   {challengeId:"44444444-4444-4444-8444-444444444444",code:"123456"});
  expect(f.verifyCalls).toBe(1);
 });
 it("revokes by exact owner-scoped mandate revision without an OTP send",async()=>{
  const response=await post({action:"revoke",mandateId:"44444444-4444-4444-8444-444444444444",revision:2});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({mandate:{revoked_at:expect.any(String)}});
  expect(vi.mocked(revokeMandate)).toHaveBeenCalledWith(
   {businessId:f.businessId,ownerUserId:f.ownerUserId},
   "44444444-4444-4444-8444-444444444444",2);
  expect(f.challengeCalls).toBe(0);
 });
 it("rejects cross-thread access without creating a mandate",async()=>{
  f.denied=true;
  const response=await post({action:"challenge",factorId:"55555555-5555-4555-8555-555555555555",
   limitValue:5,expiresAt:"2026-12-01T00:00:00Z"});
  expect(response.status).not.toBe(200);
  expect(f.challengeCalls).toBe(0);
 });
});
