import {describe,it,expect} from "vitest";
import {composeScheduleLink,validE164,eligibleForChannel,buildScheduleMessage} from "./ownerDeliveryLinks";
describe("owner-initiated schedule compose links",()=>{
 it("encodes message as a query component for wa.me (not phone plus)",()=>{
  const text="Hola María & أحمد\nMonday 7:00–15:00 + tips";
  const url=composeScheduleLink("+14155550123",text,"whatsapp");
  expect(url).toMatch(/^https:\/\/wa\.me\/14155550123\?text=/);
  expect(new URL(url).searchParams.get("text")).toBe(text);
  expect(url).not.toContain(" & ");
 });
 it("uses platform-specific SMS separators",()=>{
  const body="Shift 8:00 & 9:00 + مرحبًا";
  for(const ios of [true,false]){
   const value=composeScheduleLink("+441234567890",body,"sms",ios);
   expect(value.startsWith("sms:+441234567890"+(ios?"&":"?")+"body=")).toBe(true);
   expect(decodeURIComponent(value.split("body=")[1])).toBe(body);
  }
 });
 it("rejects untrusted, malformed, or missing recipients and checks WhatsApp consent",()=>{
  for(const p of ["14155550123","+0123","+1-415-555","+123?text=hello","+",null]){
   expect(validE164(p)).toBe(false);
  }
  expect(eligibleForChannel(null,true,"sms")).toBe("no_phone");
  expect(eligibleForChannel("+14155550123",false,"whatsapp")).toBe("not_opted_in");
  expect(eligibleForChannel("+14155550123",false,"sms")).toBe("ready");
  expect(()=>composeScheduleLink("+0123","hello","whatsapp")).toThrow();
 });
 it("formats per-person shifts without using a model",()=>{
  expect(buildScheduleMessage("ar","فاطمة","2026-11-02",[{date:"2026-11-02",start:"08:00",end:"16:00"}]))
    .toContain("فاطمة");
 });
});
