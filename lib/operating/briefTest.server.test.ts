import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({run:vi.fn(),dispatch:vi.fn(),ready:vi.fn()}));
vi.mock("./dailyBrief.server",()=>({runCafeBrief:m.run}));
vi.mock("@/lib/whatsapp/morningBriefDelivery.server",()=>({briefOutboxHook:()=>async()=>undefined,
  dispatchDueMorningBriefs:m.dispatch,whatsappBriefSendReady:m.ready,
  BRIEF_SEND_MIGRATION:"20261104000148_morning_brief_send_window.sql"}));
import {sendTestBrief,testBriefVerdict} from "./briefTest.server";

const flags=["DAILY_BRIEF_ENABLED","WHATSAPP_PROVIDER_SEND_ENABLED","WHATSAPP_POLICY_APPROVED",
  "WHATSAPP_OWNER_BRIEF_SEND_ENABLED","WHATSAPP_TEMPLATE_APPROVED","META_WHATSAPP_TOKEN","WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID"];
const saved=Object.fromEntries(flags.map(f=>[f,process.env[f]]));
const allOn=()=>{for(const f of flags.slice(0,5))process.env[f]="true";process.env.META_WHATSAPP_TOKEN="dummy";};
const cafe={id:"719af528-af8e-4203-bb25-4c118c9ff832",name:"Test Café",timezone:"America/Los_Angeles",
  currency:"USD",is_demo:false};
function db(outbox:Array<Record<string,unknown>>=[]){
  return {from:(table:string)=>{
    const q:Record<string,unknown>={};
    for(const x of ["select","eq"])q[x]=()=>q;
    q.maybeSingle=async()=>({data:table==="businesses"?cafe:null,error:null});
    q.limit=async()=>({data:outbox,error:null});
    return q;
  }} as unknown as SupabaseClient;
}
const owner=(whatsapp:Record<string,unknown>)=>({businessId:cafe.id,localDate:"2026-11-03",step:"brief",
  outcome:"sent",reason:"done",owners:[{ownerUserId:"owner-a",
    inApp:{step:"in_app",outcome:"sent",reason:"posted"},whatsapp}]});
beforeEach(()=>{
  for(const f of flags)delete process.env[f];
  m.run.mockReset();m.dispatch.mockReset().mockResolvedValue({accepted:0});m.ready.mockReset().mockResolvedValue(true);
});
afterEach(()=>{for(const f of flags){if(saved[f]===undefined)delete process.env[f];else process.env[f]=saved[f];}});

describe("Send test brief now",()=>{
  it("names the setting that is off and the step it blocked",async()=>{
    const r=await sendTestBrief(db(),cafe.id);
    expect(r?.verdict).toEqual({sent:false,step:"settings",reason:"setting_off",details:{settings:["DAILY_BRIEF_ENABLED"]}});
    expect(m.run).not.toHaveBeenCalled();
    process.env.DAILY_BRIEF_ENABLED="true";
    m.run.mockResolvedValue(owner({step:"whatsapp",outcome:"skipped",reason:"whatsapp_setting_off",
      details:{settings:["WHATSAPP_TEMPLATE_APPROVED"]}}));
    const blocked=await sendTestBrief(db(),cafe.id);
    expect(blocked?.verdict).toMatchObject({sent:false,step:"whatsapp",reason:"whatsapp_setting_off",
      details:{settings:["WHATSAPP_TEMPLATE_APPROVED"]}});
    expect(blocked?.settings.find(s=>s.name==="WHATSAPP_TEMPLATE_APPROVED")).toEqual({name:"WHATSAPP_TEMPLATE_APPROVED",on:false});
    expect(m.run).toHaveBeenCalledWith(expect.anything(),cafe,expect.any(Date),
      expect.objectContaining({kind:"test"}));
  });
  it("names the missing migration",async()=>{
    allOn();
    m.ready.mockResolvedValue(false);
    m.run.mockResolvedValue(owner({step:"whatsapp",outcome:"skipped",reason:"migration_missing",
      details:{migration:"20261104000148_morning_brief_send_window.sql"}}));
    const r=await sendTestBrief(db(),cafe.id);
    expect(r).toMatchObject({migrationReady:false,verdict:{step:"whatsapp",reason:"migration_missing",
      details:{migration:"20261104000148_morning_brief_send_window.sql"}}});
  });
  it("says sent only when Meta accepted it, and shows Meta's failure otherwise",async()=>{
    allOn();
    m.run.mockResolvedValue(owner({step:"whatsapp",outcome:"queued",reason:"queued_for_send"}));
    m.dispatch.mockResolvedValue({accepted:1});
    expect((await sendTestBrief(db([{owner_user_id:"owner-a",state:"accepted",failure_code:null}]),cafe.id))?.verdict)
      .toEqual({sent:true,step:"meta",reason:"meta_accepted",details:{state:"accepted"}});
    expect((await sendTestBrief(db([{owner_user_id:"owner-a",state:"failed",failure_code:"provider_rejected"}]),cafe.id))?.verdict)
      .toMatchObject({sent:false,step:"meta",reason:"provider_rejected"});
  });
  it("reports café-level blocks such as a missing owner or no linked number",()=>{
    const base={settings:[{name:"DAILY_BRIEF_ENABLED",on:true}],migrationReady:true,dispatch:null,outbox:[]};
    expect(testBriefVerdict({...base,result:{businessId:"x",localDate:"2026-11-03",step:"owners",
      outcome:"skipped",reason:"no_owner",owners:[]}})).toEqual({sent:false,step:"owners",reason:"no_owner"});
    expect(testBriefVerdict({...base,result:owner({step:"whatsapp",outcome:"skipped",
      reason:"no_linked_whatsapp_number"}) as never})).toMatchObject({step:"whatsapp",reason:"no_linked_whatsapp_number"});
  });
});
