import {describe,it,expect} from "vitest";
import {composeScheduleLink,validE164,eligibleForChannel,buildScheduleMessage,scheduleApprovalReply,scheduleDraftNotice,buildScheduleCopyAll} from "./ownerDeliveryLinks";
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

describe("localized prepared message templates",()=>{
 it.each(["en","es","ar"] as const)("builds %s from its locale catalog",(locale)=>{
  const message=buildScheduleMessage(locale,"Owner","2026-11-02",[{date:"2026-11-02",start:"08:00",end:"16:00"}]);
  expect(message).toContain("Owner");
  expect(message).toContain("–");
  expect(message).not.toContain("2026-11-02:");
  expect(message).not.toContain("{name}");
  expect(message).not.toContain("{week}");
 });
});

describe("manual schedule delivery guarantees",()=>{
 it("requires the owner to send, with locale-specific approval wording",()=>{
  expect(scheduleApprovalReply("en")).toBe("Approved. I can't send messages myself. Use the buttons below to open WhatsApp or SMS for each person.");
  expect(scheduleDraftNotice("en")).toContain("I can't send messages myself");
  for(const locale of ["en","es","ar"] as const){
   expect(scheduleApprovalReply(locale)).not.toMatch(/\b(?:sent|texted|delivered)\b/i);
   expect(scheduleDraftNotice(locale)).not.toMatch(/\b(?:sent|texted|delivered)\b/i);
  }
 });
 it("joins all prepared messages with recipient headers",()=>{
  expect(buildScheduleCopyAll([{name:"María",message:"Hola María"},{name:"Ahmed",message:"مرحبا أحمد"}]))
   .toBe("María\nHola María\n\nAhmed\nمرحبا أحمد");
  expect(buildScheduleCopyAll([])).toBe("");
 });
 it("uses staff-localized times and preserves the exact encoded message",()=>{
  const spanish=buildScheduleMessage("es","María","2026-11-02",[{date:"2026-11-02",start:"08:00",end:"16:00"}]);
  const arabic=buildScheduleMessage("ar","Ahmed","2026-11-02",[{date:"2026-11-02",start:"08:00",end:"16:00"}]);
  expect(spanish).toContain("María");expect(arabic).toContain("Ahmed");
  expect(spanish).not.toContain("2026-11-02:");
  expect(arabic).not.toContain("2026-11-02:");
  expect(new URL(composeScheduleLink("+34612345678",spanish,"whatsapp")).searchParams.get("text")).toBe(spanish);
 });
});
