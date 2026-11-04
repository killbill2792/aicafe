import {describe,expect,it,vi,beforeEach} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const evidenceMock=vi.hoisted(()=>({read:vi.fn()}));
const bindingMock=vi.hoisted(()=>({eligible:vi.fn()}));
vi.mock("@/lib/whatsapp/morningBrief.server",()=>({readBriefEvidence:evidenceMock.read}));
vi.mock("@/lib/whatsapp/identity.server",()=>({activeBinding:vi.fn()}));
vi.mock("@/lib/whatsapp/queue.server",()=>({enqueueWhatsApp:vi.fn(),dispatchOutboundOnce:vi.fn()}));
vi.mock("@/lib/whatsapp/morningBriefDelivery.server",async importOriginal=>({
  ...await importOriginal<typeof import("@/lib/whatsapp/morningBriefDelivery.server")>(),
  eligibleBriefBinding:bindingMock.eligible}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:vi.fn()}));
vi.mock("./cafeState",()=>({SnapshotCafeStateService:class{
  getHistoricalState=vi.fn(async()=>({
    profitability:{available:true,value:{netSalesCents:10900,totalCostsCents:6500,ownerProfitCents:4400}},
    businessCosts:{completeness:"complete"},
  }));
}}));
import {sendDailyBriefs,type BriefOutboxHook} from "./dailyBrief.server";
import {briefMessageId} from "./dailyBrief";
import {buildBriefContent,type MorningBriefEvidence} from "@/lib/whatsapp/morningBrief";

// Tuesday 05:50 PST; café opens 06:30. Owner last wrote on WhatsApp days ago.
const morning=new Date("2026-11-03T13:50:00Z");
const binding={id:"binding-1",businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",
  waId:"15556506570",phoneNumberId:"1322195347653883",lastOwnerMessageAt:"2026-10-20T05:00:00Z"};
// A plain day: no event, Seiyun-style categories not labeled yet.
const plain:MorningBriefEvidence={businessName:"Shop A",currency:"USD",today:"2026-11-03",yesterday:"2026-11-02",
  netSalesCents:10900,sold:{available:true,linked:[{id:"latte",units:3},{id:"samosa",units:5}],unlinked:[]},
  menu:[{id:"latte",name:"Latte",base_name:null,category:"Espresso"},
    {id:"samosa",name:"Samosa",base_name:null,category:"Food"}],
  categoryLabels:new Map(),events:{available:true,items:[],coverage:"complete"}};
function dbFactory(existing=false,opts:{revoked?:boolean;wrongCafe?:boolean;taskMissing?:boolean}={}){
  const mutations:Array<{table:string;op:string;row:unknown}>=[],runs:Array<Record<string,unknown>>=[];
  const q=(table:string)=>{
    const self:Record<string,unknown>={};
    for(const method of ["select","order","limit","neq","eq"])self[method]=()=>self;
    self.range=async()=>({data:table==="businesses"?
      [{id:"cafe-a",name:"Shop A",timezone:"America/Los_Angeles",currency:"USD",is_demo:false}]:
      table==="memberships"?[{user_id:existing?"owner-original":"owner-a"}]:[],error:null});
    self.maybeSingle=async()=>({error:null,data:
      table==="locations"?{open_hours:{tue:[["06:30","21:00"]]}}:
      table==="ai_messages"?(existing?{id:briefMessageId("cafe-a","2026-11-03"),
        business_id:opts.wrongCafe?"other-cafe":"cafe-a",owner_user_id:"owner-original",
        thread_id:"thread-original",structured_content:[{type:"text",text:"Previously persisted website brief."}]}:null):
      table==="memberships"?(opts.revoked?null:{user_id:existing?"owner-original":"owner-a"}):
      table==="ai_threads"?{id:existing?"thread-original":"thread-a"}:
      table==="operating_tasks"&&existing&&!opts.taskMissing?{id:"existing-task"}:null});
    self.then=(resolve:(v:unknown)=>void)=>resolve({count:1,error:null});
    self.insert=async(row:unknown)=>{mutations.push({table,op:"insert",row});return {error:null};};
    self.upsert=async(row:Record<string,unknown>)=>{
      if(table==="morning_brief_runs")runs.push(row);else mutations.push({table,op:"upsert",row});
      return {error:null};};
    self.update=(row:unknown)=>{mutations.push({table,op:"update",row});return self;};
    return self;
  };
  return {db:{from:q} as unknown as SupabaseClient,mutations,runs};
}
beforeEach(()=>{
  vi.clearAllMocks();
  evidenceMock.read.mockImplementation(async(_d:unknown,_c:unknown,_day:unknown,now:Date)=>
    ({evidence:plain,content:buildBriefContent(plain,now),posComplete:true}));
  bindingMock.eligible.mockResolvedValue({binding});
});
describe("morning brief to WhatsApp",()=>{
  it("plain day, no recent owner message: the same template text goes to the web message and the outbox",async()=>{
    const {db,mutations,runs}=dbFactory();
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>({outcome:"queued" as const}));
    expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:1,failed:0});
    const fields=["Shop A","$109.00","8 items in total (drink split not ready yet)","Samosa","5",
      "No major events near you this week.","Tuesday (automatic sales alerts are not on yet)"];
    const input=hook.mock.calls[0][0];
    expect(input.eligible?.prepared.fields).toEqual(fields);
    expect(input.eligible?.prepared.template.name).toBe("cafe_profit_daily_brief");
    expect(input.sendBefore).toBe("2026-11-03T14:30:00.000Z");
    expect(mutations[0]).toMatchObject({table:"ai_messages",
      row:{thread_id:"thread-a",structured_content:[{type:"text",text:input.websiteText}]}});
    expect(input.websiteText).toContain("Net sales: $109.00");
    expect(mutations[1]).toMatchObject({table:"operating_tasks",row:{payload:{threadId:"thread-a",text:input.websiteText}}});
    expect(runs.find(r=>r.channel==="whatsapp")).toMatchObject({outcome:"queued",reason:"queued_for_send"});
  });
  it("records why WhatsApp was skipped while the in-app brief still posts",async()=>{
    bindingMock.eligible.mockResolvedValue({reason:"whatsapp_setting_off",details:{settings:["WHATSAPP_TEMPLATE_APPROVED"]}});
    const {db,mutations,runs}=dbFactory();
    const hook=vi.fn(async(_input:Parameters<BriefOutboxHook>[0])=>undefined);
    expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:1});
    expect(mutations[0]).toMatchObject({table:"ai_messages"});
    expect(hook.mock.calls[0][0]).toMatchObject({eligible:null});
    expect(runs.find(r=>r.channel==="whatsapp")).toMatchObject({outcome:"skipped",reason:"whatsapp_setting_off",
      details:expect.objectContaining({settings:["WHATSAPP_TEMPLATE_APPROVED"]})});
  });
  it("retries an outbox opportunity without duplicating the web message or inbox",async()=>{
    const {db,mutations}=dbFactory(true);
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
    expect(await sendDailyBriefs(db,morning,hook)).toEqual({checked:1,sent:0,skipped:1,failed:0});
    expect(mutations).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(1);
    // The saved web text differs from today's template text: never send a different text.
    expect(hook.mock.calls[0][0]).toMatchObject({ownerUserId:"owner-original",threadId:"thread-original",
      websiteText:"Previously persisted website brief.",eligible:null});
  });
  it("after the café opens, an already posted brief is not re-offered and its records are left alone",async()=>{
    const {db,mutations,runs}=dbFactory(true);
    const hook=vi.fn(async()=>({outcome:"queued" as const}));
    await sendDailyBriefs(db,new Date("2026-11-03T14:40:00Z"),hook); // 06:40, opened at 06:30
    expect(hook).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
    expect(runs).toEqual([]);
  });
  it("repairs a missing inbox record after a saved Supervisor message without duplicating chat",async()=>{
    const {db,mutations}=dbFactory(true,{taskMissing:true});
    await sendDailyBriefs(db,morning,vi.fn(async()=>{}));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({table:"operating_tasks",op:"upsert",
      row:{id:"daily-brief:2026-11-03:owner-original",payload:{ownerUserId:"owner-original",
        threadId:"thread-original",text:"Previously persisted website brief."}}});
  });
  it("skips revoked ownership or a foreign café instead of sending the persisted brief, with a reason",async()=>{
    for(const [opts,reason] of [[{revoked:true},"not_an_owner"],[{wrongCafe:true},"saved_brief_scope_mismatch"]] as const){
      const {db,mutations,runs}=dbFactory(true,opts);
      const hook=vi.fn(async()=>{});
      expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:0,skipped:1,failed:0});
      expect(hook).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
      expect(runs.find(r=>r.channel==="in_app")).toMatchObject({outcome:"skipped",reason});
    }
  });
  it("a failed outbox never loses the web record and is recorded as a WhatsApp failure",async()=>{
    const {db,mutations,runs}=dbFactory();
    expect(await sendDailyBriefs(db,morning,async()=>{throw new Error("queue_offline");}))
      .toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(mutations.map(m=>m.table)).toEqual(["ai_messages","operating_tasks","operating_tasks"]);
    expect(runs.find(r=>r.channel==="whatsapp")).toMatchObject({outcome:"failed",reason:"whatsapp_enqueue_error"});
  });
});
