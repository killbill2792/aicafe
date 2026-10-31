import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {BUTTONS,buildOutbound,buttonQuestion,validTemplateFields} from "./transport";
import {providerAllowed,sendMeta} from "./transport.server";
const fields=["Cafe North","$1,700.00","190","Matcha","89","Halloween today, verified nearby event","Saturday"] as const;
const flags=["WHATSAPP_PROVIDER_SEND_ENABLED","WHATSAPP_POLICY_APPROVED",
  "WHATSAPP_OWNER_BRIEF_SEND_ENABLED","WHATSAPP_OWNER_REPLY_SEND_ENABLED",
  "WHATSAPP_TEMPLATE_APPROVED","META_WHATSAPP_TOKEN","WHATSAPP_TOKEN","WHATSAPP_PHONE_NUMBER_ID"];
const enable=(kind:"daily_brief"|"reply")=>{
  process.env.WHATSAPP_PROVIDER_SEND_ENABLED="true";
  process.env.WHATSAPP_POLICY_APPROVED="true";
  process.env.META_WHATSAPP_TOKEN="dummy_test_credential";
  process.env[kind==="daily_brief"?"WHATSAPP_OWNER_BRIEF_SEND_ENABLED":"WHATSAPP_OWNER_REPLY_SEND_ENABLED"]="true";
  process.env.WHATSAPP_TEMPLATE_APPROVED="true";
};
beforeEach(()=>flags.forEach(f=>delete process.env[f]));
afterEach(()=>flags.forEach(f=>delete process.env[f]));

describe("Meta Graph owner transport",()=>{
  it("preserves all seven body values and the four exact quick replies at their approved indices",()=>{
    const data=buildOutbound("+15556506570",{kind:"daily_brief",fields}) as {
      template:{name:string;language:{code:string};components:
        {type:string;index?:string;parameters:{type:string;text?:string;payload?:string}[]}[]};to:string};
    expect(data.to).toBe("15556506570");
    expect(data.template.name).toBe("cafe_profit_daily_brief");
    expect(data.template.language.code).toBe("en_US");
    expect(data.template.components[0].parameters.map(p=>p.text)).toEqual(fields);
    expect(data.template.components.slice(1).map(b=>[b.index,b.parameters[0].type,b.parameters[0].payload])).toEqual([
      ["0","payload","money_went"],["1","payload","peak_today"],
      ["2","payload","slowest_yesterday"],["3","payload","event_today"],
    ]);
    expect(BUTTONS.map(b=>b.label)).toEqual([
      "Where did my money go?","Peak hours today?",
      "Yesterday's slowest hour?","About today's event",
    ]);
    expect(BUTTONS.every(b=>b.label.length<=25)).toBe(true);
    expect(buttonQuestion("money_went")).toBe("Where did my money go yesterday?");
    expect(buttonQuestion("peak_today")).toBe("What are my usual busiest hours for today?");
    expect(buttonQuestion("slowest_yesterday")).toBe("What was my slowest hour yesterday?");
    expect(buttonQuestion("event_today")).toBe("Tell me more about today's saved nearby event.");
    expect(buttonQuestion("Where did my money go?")).toBeNull();
  });
  it("rejects missing/injected/long fields and malformed phone; never fills unknowns",()=>{
    expect(validTemplateFields([...fields.slice(0,6),""])).toBe(false);
    expect(validTemplateFields([...fields.slice(0,6),"line\nbreak"])).toBe(false);
    expect(validTemplateFields([...fields.slice(0,6),"<script>"])).toBe(false);
    expect(validTemplateFields([...fields.slice(0,6),"a".repeat(257)])).toBe(false);
    expect(buildOutbound("555", {kind:"daily_brief",fields})).toBeNull();
    expect(buildOutbound("+15556506570", {kind:"daily_brief",
      fields:[...fields.slice(0,6),"missing\tdate"] as unknown as typeof fields})).toBeNull();
    expect(buildOutbound("+15556506570",{kind:"reply",text:"x".repeat(4097)})).toBeNull();
  });
  it("defaults completely off even with the old task-alert flag on",async()=>{
    process.env.AI_CAFE_WHATSAPP_ENABLED="true";
    const send=vi.fn();
    expect(providerAllowed("daily_brief")).toBe(false);
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},send)).toEqual({
      state:"failed",reason:"provider_disabled"});
    expect(send).not.toHaveBeenCalled();
    delete process.env.AI_CAFE_WHATSAPP_ENABLED;
  });
  it("requires separate brief/reply flags and sender is the Meta test phone",async()=>{
    enable("daily_brief");
    expect(providerAllowed("reply")).toBe(false);
    process.env.WHATSAPP_PHONE_NUMBER_ID="999999999999";
    expect(providerAllowed("daily_brief")).toBe(false);
    const send=vi.fn();
    expect((await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},send)).state).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
  it("distinguishes acceptance, definite 429 retry, explicit rejection, ambiguous timeout/5xx",async()=>{
    enable("daily_brief");
    const make=(status:number,receipt:unknown={})=>vi.fn(async()=>({status,ok:status===200,json:async()=>receipt}) as Response);
    const good=make(200,{messages:[{id:"wamid.accepted123"}]});
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},good)).toEqual({
      state:"accepted",wamid:"wamid.accepted123"});
    expect(String(good.mock.calls[0].length)).toBe("2");
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},make(429)))
      .toEqual({state:"retry",reason:"rate_limited"});
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},make(400)))
      .toEqual({state:"failed",reason:"provider_rejected"});
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},make(503)))
      .toEqual({state:"uncertain",reason:"provider_ambiguous"});
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},make(200)))
      .toEqual({state:"uncertain",reason:"missing_acceptance_id"});
    const timeout=vi.fn(async()=>{throw new Error("abort");});
    expect(await sendMeta("daily_brief","15556506570",{kind:"daily_brief",fields},
      timeout as unknown as typeof fetch)).toEqual({state:"uncertain",reason:"network_or_timeout_ambiguous"});
  });
});
