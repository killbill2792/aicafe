import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFactRows:vi.fn(async()=>[
 {business_date:"2026-10-30",sales_data_status:"actual",net_sales_cents:10900}])}));
vi.mock("@/lib/whatsapp/morningBriefDelivery.server",()=>({
 eligibleBriefBinding:vi.fn(async()=>null),prepareBoundBrief:vi.fn(async()=>null),
}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:vi.fn()}));
vi.mock("./cafeState",()=>({SnapshotCafeStateService:class{
  getHistoricalState=vi.fn(async()=>({
    profitability:{available:true,value:{netSalesCents:10900,totalCostsCents:6500,ownerProfitCents:4400}},
    businessCosts:{completeness:"complete"},
  }));
}}));
import {sendDailyBriefs,type BriefOutboxHook} from "./dailyBrief.server";
import {eligibleBriefBinding,prepareBoundBrief} from "@/lib/whatsapp/morningBriefDelivery.server";
import {renderMorningBrief} from "@/lib/whatsapp/morningBrief";
import {briefMessageId} from "./dailyBrief";

const morning=new Date("2026-10-31T12:50:00Z");
function dbFactory(existing=false,opts:{revoked?:boolean;wrongCafe?:boolean;taskMissing?:boolean}={}){
  const mutations:Array<{table:string;op:string;row:unknown}>=[];
  const scopedReads:Array<{table:string;column:string;value:unknown}>=[];
  const q=(table:string)=>{
    const self:Record<string,unknown>={};
    for(const method of ["select","order","limit","neq"])self[method]=()=>self;
    self.eq=(column:string,value:unknown)=>{scopedReads.push({table,column,value});return self;};
    self.range=async()=>({data:table==="businesses"?
      [{id:"cafe-a",name:"Shop A",timezone:"America/Los_Angeles",currency:"USD",is_demo:false}]:
      table==="memberships"?[{user_id:existing?"owner-original":"owner-a"}]:[],error:null});
    self.maybeSingle=async()=>({error:null,data:table==="ai_messages"?
      (existing?{id:briefMessageId("cafe-a","2026-10-31"),
        business_id:opts.wrongCafe?"other-cafe":"cafe-a",owner_user_id:"owner-original",
        thread_id:"thread-original",
        structured_content:[{type:"text",text:"Previously persisted website brief."}]}:null):
      table==="memberships"?(opts.revoked?null:{user_id:existing?"owner-original":"owner-a"}):
      table==="ai_threads"?{id:existing?"thread-original":"thread-a"}:
      table==="operating_tasks"&&existing&&!opts.taskMissing?{id:"existing-task"}:null});
    self.then=(resolve:(v:unknown)=>void)=>resolve({count:1,error:null});
    self.insert=async(row:unknown)=>{mutations.push({table,op:"insert",row});return {error:null};};
    self.upsert=async(row:unknown)=>{mutations.push({table,op:"upsert",row});return {error:null};};
    self.update=(row:unknown)=>{mutations.push({table,op:"update",row});return self;};
    return self;
  };
  return {db:{from:q} as unknown as SupabaseClient,mutations,scopedReads};
}
describe("morning brief optional durable-outbox seam",()=>{
  it("puts EXACT same approved seven-field text in the one web message and outbound opportunity",async()=>{
    const {db,mutations}=dbFactory();
    const params=["Shop A","$109.00","3","Latte","3","Festival at 15:00","Saturday"] as const;
    const webText=renderMorningBrief(params);
    const binding={id:"binding-1",businessId:"cafe-a",ownerUserId:"owner-a",
      threadId:"thread-a",waId:"15556506570",phoneNumberId:"1322195347653883",
      lastOwnerMessageAt:"2026-10-31T05:00:00Z"};
    const eligible={binding,websiteText:webText,prepared:{parameters:params,
      netSalesCents:10900,businessDate:"2026-10-30",today:"2026-10-31",
      provenance:{sales:"daily_rollups",items:"menu_item_quantities_sold",
        menu:"menu_items",eventId:"e1",monitorProposalId:"m1"}}};
    vi.mocked(eligibleBriefBinding).mockResolvedValueOnce(binding);
    vi.mocked(prepareBoundBrief).mockResolvedValueOnce(eligible);
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
    expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:1,failed:0});
    expect(mutations[0]).toMatchObject({table:"ai_messages",
      row:{thread_id:"thread-a",structured_content:[{type:"text",text:webText}]}});
    expect(mutations[1]).toMatchObject({table:"operating_tasks",
      row:{payload:{threadId:"thread-a",text:webText}}});
    expect(hook.mock.calls[0][0].eligible?.prepared.parameters).toEqual(params);
    expect(hook.mock.calls[0][0].websiteText).toBe(webText);
  });

  it("persists the canonical website and inbox brief before offering the same day to transport",async()=>{
    const {db,mutations}=dbFactory();
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{expect(mutations.map(m=>m.table))
      .toEqual(["ai_messages","operating_tasks","operating_tasks"]);});
    expect(await sendDailyBriefs(db,morning,hook)).toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({businessId:"cafe-a",ownerUserId:"owner-a",
      threadId:"thread-a",websiteMessageId:briefMessageId("cafe-a","2026-10-31","owner-a"),
      today:"2026-10-31",yesterday:"2026-10-30",businessName:"Shop A"});
    expect(hook.mock.calls[0][0].websiteText).toContain("Yesterday:");
  });
  it("retries an outbox opportunity without duplicating the web message or inbox",async()=>{
    const {db,mutations,scopedReads}=dbFactory(true);
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
    expect(await sendDailyBriefs(db,morning,hook)).toEqual({checked:1,sent:0,skipped:1,failed:0});
    expect(mutations).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({ownerUserId:"owner-original",
      threadId:"thread-original",websiteText:"Previously persisted website brief."});
    expect(scopedReads).toContainEqual({table:"memberships",column:"user_id",value:"owner-original"});
    expect(scopedReads).toContainEqual({table:"ai_threads",column:"id",value:"thread-original"});
  });
  it("repairs a missing inbox record after a saved Supervisor message without duplicating chat",async()=>{
    const {db,mutations}=dbFactory(true,{taskMissing:true});
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
    expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:0,skipped:1,failed:0});
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({table:"operating_tasks",op:"upsert",
      row:{id:"daily-brief:2026-10-31:owner-original",
        payload:{ownerUserId:"owner-original",threadId:"thread-original",
          text:"Previously persisted website brief."}}});
    expect(hook).toHaveBeenCalledTimes(1);
  });
  it("skips revoked ownership or a foreign café instead of sending the persisted brief",async()=>{
    for(const opts of [{revoked:true},{wrongCafe:true}]){
      const {db,mutations}=dbFactory(true,opts);
      const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
      expect(await sendDailyBriefs(db,morning,hook)).toMatchObject({sent:0,skipped:1,failed:0});
      expect(hook).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
    }
  });
  it("never delivers on the default path and never loses the web record on a failed outbox",async()=>{
    const {db,mutations}=dbFactory();
    expect(await sendDailyBriefs(db,morning,async()=>{throw new Error("queue_offline");}))
      .toEqual({checked:1,sent:0,skipped:0,failed:1});
    expect(mutations.map(m=>m.table)).toEqual(["ai_messages","operating_tasks","operating_tasks"]);
    const fresh=dbFactory();
    expect(await sendDailyBriefs(fresh.db,morning)).toMatchObject({sent:1,failed:0});
  });
});
