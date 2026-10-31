import { describe, expect, it } from "vitest";
import { eligibleWhatsAppTextReply, supervisorQuestionForWhatsApp, withinWhatsAppServiceWindow } from "./supervisor";

describe("WhatsApp owner prompts use payloads, never display labels", () => {
  it.each([
    ["money_went", "Where did my money go yesterday?"],
    ["peak_today", "What are my usual busiest hours for today?"],
    ["slowest_yesterday", "What was my slowest hour yesterday?"],
    ["event_today", "Tell me more about today's saved nearby event."],
  ])("maps %s to the one Supervisor question", (payload, question) => {
    expect(supervisorQuestionForWhatsApp({type:"button",payload,text:"arbitrary translated label"})).toBe(question);
    expect(supervisorQuestionForWhatsApp({type:"interactive",interactive:{
      type:"button_reply",button_reply:{id:payload,title:"different title"},
    }})).toBe(question);
  });
  it("sends arbitrary Unicode text to the same Supervisor without keyword routing", () => {
    expect(supervisorQuestionForWhatsApp({type:"text",text:"  ما هي مبيعات الأمس؟  "})).toBe("ما هي مبيعات الأمس؟");
    expect(supervisorQuestionForWhatsApp({type:"text",text:"Can you check inventory?"})).toBe("Can you check inventory?");
  });
  it("rejects unknown payloads and never interprets button labels as identifiers", () => {
    expect(()=>supervisorQuestionForWhatsApp({type:"button",payload:"Where did my money go?"})).toThrow("unknown_whatsapp_button_payload");
    expect(()=>supervisorQuestionForWhatsApp({type:"button",payload:"approve_purchase"})).toThrow();
    expect(()=>supervisorQuestionForWhatsApp({type:"text",text:"   "})).toThrow();
  });
});
describe("WhatsApp freeform reply window",()=>{
  const received = new Date("2026-10-31T08:00:00Z");
  it("allows 23:59:59 but not 24:00:00, future or invalid timestamps",()=>{
    expect(withinWhatsAppServiceWindow(received,new Date("2026-11-01T07:59:59Z"))).toBe(true);
    expect(withinWhatsAppServiceWindow(received,new Date("2026-11-01T08:00:00Z"))).toBe(false);
    expect(withinWhatsAppServiceWindow(received,new Date("2026-10-31T07:59:59Z"))).toBe(false);
    expect(withinWhatsAppServiceWindow("nonsense",new Date())).toBe(false);
  });
  it("refuses overlong/empty replies instead of clipping or silently rewriting",()=>{
    expect(eligibleWhatsAppTextReply("ok",received,new Date("2026-10-31T08:00:01Z"))).toBe(true);
    expect(eligibleWhatsAppTextReply("a".repeat(4097),received,new Date("2026-10-31T08:00:01Z"))).toBe(false);
    expect(eligibleWhatsAppTextReply("  ",received,new Date("2026-10-31T08:00:01Z"))).toBe(false);
  });
});
