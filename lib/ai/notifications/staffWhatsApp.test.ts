import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {sendApprovedStaffWhatsApp} from "./staffWhatsApp.server";
const phone="+14155550123";
const ready={STAFF_WHATSAPP:"true",WHATSAPP_TOKEN:"secret",WHATSAPP_PHONE_NUMBER_ID:"100"};
describe("staff WhatsApp Cloud API transport",()=>{
 it("does not transmit with the default-off flag",async()=>{
  const f=vi.fn();
  expect(await sendApprovedStaffWhatsApp(phone,"staff_schedule",{env:{},fetcher:f as unknown as typeof fetch}))
   .toEqual({status:"prepared",reason:"disabled"});
  expect(f).not.toHaveBeenCalled();
 });
 it("does not transmit without credentials",async()=>{
  const f=vi.fn();
  expect(await sendApprovedStaffWhatsApp(phone,"staff_schedule",
   {env:{STAFF_WHATSAPP:"true"},fetcher:f as unknown as typeof fetch}))
   .toEqual({status:"prepared",reason:"missing_credentials"});
  expect(f).not.toHaveBeenCalled();
 });
 it("sends a Meta-approved template without exposing credentials in results",async()=>{
  const f=vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[{id:"wamid.123"}]})});
  expect(await sendApprovedStaffWhatsApp(phone,"staff_schedule",
   {env:ready,fetcher:f as unknown as typeof fetch}))
   .toEqual({status:"sent",messageId:"wamid.123"});
  expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({
   to:phone,type:"template",template:{name:"staff_schedule"}});
 });
 it("returns explicit failure without retrying a potentially accepted send",async()=>{
  const f=vi.fn().mockRejectedValue(new Error("connection lost"));
  expect(await sendApprovedStaffWhatsApp(phone,"staff_schedule",
   {env:ready,fetcher:f as unknown as typeof fetch}))
   .toEqual({status:"failed",reason:"provider_unavailable"});
  expect(f).toHaveBeenCalledTimes(1);
 });
});
