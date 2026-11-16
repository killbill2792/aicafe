import {describe,it,expect,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({
 inbox:vi.fn(),reply:vi.fn(),link:vi.fn(),links:vi.fn(),
}));
vi.mock("@/lib/staffCommunication/channel.server",()=>({
 getStaffInbox:mocks.inbox,submitStaffReply:mocks.reply,
 ownerStaffLoginList:mocks.links,ownerLinkExistingLogin:mocks.link,
 StaffChannelError:class StaffChannelError extends Error{
  constructor(public code:string){super(code);}
 }
}));
import {GET as get,POST as post} from "./route";
import {GET as getLinks,POST as postLinks} from "./link/route";
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
