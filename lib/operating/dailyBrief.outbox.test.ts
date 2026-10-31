import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:vi.fn()}));
vi.mock("./cafeState",()=>({SnapshotCafeStateService:class{
  getHistoricalState=vi.fn(async()=>({
    profitability:{available:true,value:{netSalesCents:10900,totalCostsCents:6500,ownerProfitCents:4400}},
    businessCosts:{completeness:"complete"},
  }));
}}));
import {sendDailyBriefs,type BriefOutboxHook} from "./dailyBrief.server";
import {briefMessageId} from "./dailyBrief";

const morning=new Date("2026-10-31T15:30:00Z");
function dbFactory(existing=false){
  const mutations:Array<{table:string;op:string;row:unknown}>=[];
  const q=(table:string)=>{
    const self:Record<string,unknown>={};
    for(const method of ["select","eq","order","limit","neq"])self[method]=()=>self;
    self.range=async()=>({data:table==="businesses"?
      [{id:"cafe-a",name:"Shop A",timezone:"America/Los_Angeles",currency:"USD",is_demo:false}]:[],error:null});
    self.maybeSingle=async()=>({error:null,data:table==="ai_messages"?
      (existing?{id:briefMessageId("cafe-a","2026-10-31"),
        structured_content:[{type:"text",text:"Previously persisted website brief."}]}:null):
      table==="memberships"?{user_id:"owner-a"}:table==="ai_threads"?{id:"thread-a"}:null});
    self.then=(resolve:(v:unknown)=>void)=>resolve({count:1,error:null});
    self.insert=async(row:unknown)=>{mutations.push({table,op:"insert",row});return {error:null};};
    self.upsert=async(row:unknown)=>{mutations.push({table,op:"upsert",row});return {error:null};};
    self.update=(row:unknown)=>{mutations.push({table,op:"update",row});return self;};
    return self;
  };
  return {db:{from:q} as unknown as SupabaseClient,mutations};
}
describe("morning brief optional durable-outbox seam",()=>{
  it("persists the canonical website and inbox brief before offering the same day to transport",async()=>{
    const {db,mutations}=dbFactory();
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{expect(mutations.map(m=>m.table))
      .toEqual(["ai_messages","operating_tasks","operating_tasks"]);});
    expect(await sendDailyBriefs(db,morning,hook)).toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({businessId:"cafe-a",ownerUserId:"owner-a",
      threadId:"thread-a",websiteMessageId:briefMessageId("cafe-a","2026-10-31"),
      today:"2026-10-31",yesterday:"2026-10-30",businessName:"Shop A"});
    expect(hook.mock.calls[0][0].websiteText).toContain("Yesterday:");
  });
  it("retries an outbox opportunity without duplicating the web message or inbox",async()=>{
    const {db,mutations}=dbFactory(true);
    const hook=vi.fn(async (_input:Parameters<BriefOutboxHook>[0])=>{});
    expect(await sendDailyBriefs(db,morning,hook)).toEqual({checked:1,sent:0,skipped:1,failed:0});
    expect(mutations).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0].websiteText).toBe("Previously persisted website brief.");
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
