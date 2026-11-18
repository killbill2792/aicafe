import {describe,it,expect,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({
 inbox:vi.fn(),reply:vi.fn(),link:vi.fn(),links:vi.fn(),ownerSend:vi.fn(),assign:vi.fn(),
}));
vi.mock("@/lib/staffCommunication/channel.server",()=>({
 getStaffInbox:mocks.inbox,submitStaffReply:mocks.reply,
 ownerStaffLoginList:mocks.links,ownerLinkExistingLogin:mocks.link,
 sendOwnerStaffMessage:mocks.ownerSend,assignOwnerStaffWork:mocks.assign,
 StaffChannelError:class StaffChannelError extends Error{
  constructor(public code:string){super(code);}
 }
}));
import {StaffChannelError} from "@/lib/staffCommunication/channel.server";
import {GET as get,POST as post} from "./route";
import {GET as getLinks,POST as postLinks} from "./link/route";
import {POST as ownerPost} from "./owner-message/route";
import {POST as ownerAssign} from "./owner-assignment/route";
const origin="https://example.test";
const url=origin+"/api/staff-channel";
const req=(body:unknown,headers:Record<string,string>={})=>
 new Request(url,{method:"POST",headers:{
  Origin:origin,"Content-Type":"application/json",...headers,
 },body:JSON.stringify(body)});
const reply={requestId:"11111111-1111-4111-8111-111111111111",
 response:"decline",body:"I can work at eight, not seven",
 nonce:"22222222-2222-4222-8222-222222222222"};
beforeEach(()=>{
 Object.values(mocks).forEach(x=>x.mockReset());
 mocks.reply.mockResolvedValue({id:"33333333-3333-4333-8333-333333333333",replayed:false});
 mocks.link.mockResolvedValue({linked:true});
 mocks.ownerSend.mockResolvedValue({id:"33333333-3333-4333-8333-333333333333",replayed:false});
 mocks.assign.mockResolvedValue({id:"44444444-4444-4444-8444-444444444444",replayed:false});
 mocks.links.mockResolvedValue([]);
 mocks.inbox.mockResolvedValue({name:"Ava",requests:[],messages:[]});
});
describe("restricted staff communication APIs",()=>{
 it("posts structured plus free-text as one scoped submission",async()=>{
  const r=await post(req(reply));
  expect(r.status).toBe(200);
  expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(reply);
  expect((await r.json()).replayed).toBe(false);
 });
 it("identifies only proven stale source request as a definitive non-commit",async()=>{
  mocks.reply.mockRejectedValueOnce(new StaffChannelError("stale_request"));
  const old=await post(req(reply));
  expect(old.status).toBe(409);
  expect(await old.json()).toEqual({error:"stale_request"});
  mocks.reply.mockRejectedValueOnce(new StaffChannelError("conflict"));
  const uncertain=await post(req(reply));
  expect(uncertain.status).toBe(409);
  expect(await uncertain.json()).toEqual({error:"conflict"});
 });
 it("forbids cross-origin and non-JSON writes before reaching service",async()=>{
  const forged=await post(req(reply,{Origin:"https://evil.test"}));
  expect(forged.status).toBe(403);
  const wrong=await post(req(reply,{"Content-Type":"text/plain"}));
  expect(wrong.status).toBe(415);
  expect(mocks.reply).not.toHaveBeenCalled();
 });
 it("reads only through authenticated staff scope and surfaces service denial",async()=>{
  expect((await get()).status).toBe(200);
  expect(mocks.inbox).toHaveBeenCalledTimes(1);
  mocks.inbox.mockRejectedValueOnce({code:"not_linked"});
  expect((await get()).status).toBe(503);
 });
 it("owner-click reply is routed only through checked owner port and preserves text",async()=>{
  const input={employeeId:reply.requestId,body:"Can you start at eight?",
    nonce:reply.nonce};
  const ok=await ownerPost(req(input));
  expect(ok.status).toBe(200);
  expect(mocks.ownerSend).toHaveBeenCalledExactlyOnceWith(input);
  expect((await ok.json()).replayed).toBe(false);
  const attacker=await ownerPost(req(input,{Origin:"https://attacker.test"}));
  expect(attacker.status).toBe(403);
  expect(mocks.ownerSend).toHaveBeenCalledOnce();
 });
 it("reuses owner-scoped worker assignments for task/checklist without raw staff writes",async()=>{
  const assignment={employeeId:reply.requestId,kind:"checklist",
    title:"Opening checks",prompt:"Check the grinder and report any problem",
    nonce:reply.nonce};
  const accepted=await ownerAssign(req(assignment));
  expect(accepted.status).toBe(200);
  expect(mocks.assign).toHaveBeenCalledExactlyOnceWith(assignment);
  expect((await accepted.json()).replayed).toBe(false);
  expect((await ownerAssign(req(assignment,{Origin:"https://evil.test"}))).status).toBe(403);
  expect(mocks.assign).toHaveBeenCalledOnce();
 });
 it("returns definitive unsent owner target rejection without pretending a receipt exists",async()=>{
  const message={employeeId:reply.requestId,body:"Please check your shift",nonce:reply.nonce};
  mocks.ownerSend.mockRejectedValueOnce(new StaffChannelError("stale_request"));
  const staleMessage=await ownerPost(req(message));
  expect(staleMessage.status).toBe(409);
  expect(await staleMessage.json()).toEqual({error:"stale_request"});
  const assignment={employeeId:reply.requestId,kind:"task",title:"Check supplies",
   prompt:"Report any shortages",nonce:reply.nonce};
  mocks.assign.mockRejectedValueOnce(new StaffChannelError("stale_request"));
  const staleAssignment=await ownerAssign(req(assignment));
  expect(staleAssignment.status).toBe(409);
  expect(await staleAssignment.json()).toEqual({error:"stale_request"});
  mocks.ownerSend.mockRejectedValueOnce(new StaffChannelError("conflict"));
  const uncertain=await ownerPost(req(message));
  expect(uncertain.status).toBe(409);
  expect(await uncertain.json()).toEqual({error:"conflict"});
 });
 it("owner link API reuses owner authorization service and checks origin",async()=>{
  expect((await getLinks()).status).toBe(200);
  expect(mocks.links).toHaveBeenCalledOnce();
  const request=req({employeeId:reply.requestId,email:"staff@example.invalid"});
  expect((await postLinks(request)).status).toBe(200);
  expect(mocks.link).toHaveBeenCalledOnce();
  const malicious=req({employeeId:reply.requestId,email:"staff@example.invalid"},
    {Origin:"https://evil.test"});
  expect((await postLinks(malicious)).status).toBe(403);
  expect(mocks.link).toHaveBeenCalledOnce();
 });
});
