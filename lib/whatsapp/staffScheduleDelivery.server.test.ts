import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {sendStaffScheduleTemplate,staffProviderBlockers} from "./staffScheduleDelivery.server";
const allowed={
 WHATSAPP_PROVIDER_SEND_ENABLED:"true",WHATSAPP_POLICY_APPROVED:"true",
 WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED:"true",WHATSAPP_STAFF_TEMPLATE_APPROVED:"true",
 META_WHATSAPP_TOKEN:"test-token",WHATSAPP_STAFF_SCHEDULE_TEMPLATE:"staff_schedule_approved",
};
beforeEach(()=>{for(const [k,v] of Object.entries(allowed))vi.stubEnv(k,v);});
afterEach(()=>vi.unstubAllEnvs());
describe("Task 13B staff send: real provider receipts, not a chat-only message",()=>{
 it("requires independent opt-in policy, template and provider flags before HTTP",async()=>{
  vi.stubEnv("WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED","false");
  expect(staffProviderBlockers()).toContain("WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED");
  const send=vi.fn();
  expect(await sendStaffScheduleTemplate("+14155550123","Monday 09:00",send))
    .toEqual({state:"failed",reason:"staff_provider_disabled"});
  expect(send).not.toHaveBeenCalled();
 });
 it("does not expose owner-only chat buttons or use free text; sends only template parameter",async()=>{
  const send=vi.fn(async(_url:string,req:RequestInit)=>{
   const body=JSON.parse(String(req.body));
   expect(body).toMatchObject({messaging_product:"whatsapp",to:"14155550123",type:"template",
     template:{name:"staff_schedule_approved",language:{code:"en_US"}}});
   expect(body.template.components[0].parameters).toEqual([{type:"text",text:"Your week starts Monday"}]);
   expect(body).not.toHaveProperty("text");
   return Response.json({messages:[{id:"wamid.provider-receipt"}]});
  });
  expect(await sendStaffScheduleTemplate("+14155550123","Your week starts Monday",
    send as unknown as typeof fetch))
    .toEqual({state:"accepted",wamid:"wamid.provider-receipt"});
  expect(send).toHaveBeenCalledTimes(1);
 });
 it("rejects wrong number, unsupported sender and oversized template without contacting Meta",async()=>{
  const send=vi.fn();
  expect(await sendStaffScheduleTemplate("555123","Message",send))
    .toMatchObject({state:"failed"});
  expect(await sendStaffScheduleTemplate("+14155550123","x".repeat(1001),send))
    .toMatchObject({state:"failed"});
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID","a-nonapproved-number");
  expect(staffProviderBlockers()).toContain("approved staff webhook sender");
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send))
    .toEqual({state:"failed",reason:"staff_provider_disabled"});
  expect(send).not.toHaveBeenCalled();
 });
 it("does not equate HTTP success without a wamid with a send or delivery",async()=>{
  const send=vi.fn(async()=>Response.json({messages:[{}]}));
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send as unknown as typeof fetch))
    .toEqual({state:"uncertain",reason:"missing_acceptance_id"});
 });
 it("treats 5xx, thrown network and deadline abort as uncertain, never retries",async()=>{
  const send=vi.fn(async()=>new Response("error",{status:503}));
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send as unknown as typeof fetch))
    .toMatchObject({state:"uncertain"});
  send.mockRejectedValueOnce(new Error("network lost"));
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send as unknown as typeof fetch))
    .toMatchObject({state:"uncertain"});
  expect(send).toHaveBeenCalledTimes(2);
 });
 it("distinguishes provider refusal from sent, and 429 from ambiguous replay",async()=>{
  const send=vi.fn(async()=>new Response("{}",{status:429}));
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send as unknown as typeof fetch))
    .toMatchObject({state:"retry"});
  send.mockResolvedValueOnce(Response.json({error:{code:131026,message:"Recipient not available"}},{status:400}));
  expect(await sendStaffScheduleTemplate("+14155550123","Message",send as unknown as typeof fetch))
    .toMatchObject({state:"failed"});
 });
});
