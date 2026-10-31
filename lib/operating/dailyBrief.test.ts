import {describe,expect,it,vi,beforeEach} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {briefDue,briefMessageId,briefText,briefWindow} from "./dailyBrief";
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFactRows:vi.fn(async()=>[
  {business_date:"2026-10-28",sales_data_status:"actual",net_sales_cents:240000}])}));

const state={profitability:{available:true,value:{netSalesCents:240_000,totalCostsCents:160_000,ownerProfitCents:80_000}},
  businessCosts:{completeness:"complete"}};
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:vi.fn()}));
vi.mock("./cafeState",()=>({SnapshotCafeStateService:class{getHistoricalState=vi.fn(async()=>state);}}));
import {sendDailyBriefs} from "./dailyBrief.server";

const zone="America/Los_Angeles";
describe("daily brief text and timing",()=>{
  it("uses 05:50–06:00 café-local publication through fall and spring DST",()=>{
    const at=(time:string)=>new Date(time);
    expect(briefDue(at("2026-10-29T11:59:00Z"),zone).due).toBe(false); // 04:59
    expect(briefDue(at("2026-10-29T12:10:00Z"),zone).due).toBe(true);  // 05:10 readiness
    expect(briefDue(at("2026-10-29T12:50:00Z"),zone)).toEqual(
      {due:true,today:"2026-10-29",yesterday:"2026-10-28"});
    expect(briefWindow(at("2026-10-29T12:50:00Z"),zone))
      .toEqual({readyToPublish:true,beforeDeadline:true,fallback:false});
    expect(briefWindow(at("2026-10-29T13:00:00Z"),zone))
      .toEqual({readyToPublish:true,beforeDeadline:false,fallback:true});
    expect(briefDue(at("2026-10-29T13:23:00Z"),zone).due).toBe(false);
    expect(briefDue(at("2026-11-01T13:50:00Z"),zone).today).toBe("2026-11-01");
    expect(briefWindow(at("2026-11-01T13:50:00Z"),zone).beforeDeadline).toBe(true);
    expect(briefDue(at("2027-03-14T12:50:00Z"),zone).today).toBe("2027-03-14");
  });
  it("has one stable message id per café and day",()=>{
    expect(briefMessageId("a","2026-10-29")).toBe(briefMessageId("a","2026-10-29"));
    expect(briefMessageId("a","2026-10-29")).not.toBe(briefMessageId("a","2026-10-30"));
    expect(briefMessageId("a","2026-10-29")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("gives yesterday's numbers in the café currency and what needs the owner",()=>{
    expect(briefText({locale:"en",currency:"USD",needsOwner:3,
      yesterday:{netSalesCents:240_000,totalCostsCents:160_000,ownerProfitCents:80_000,complete:true}}))
      .toBe("Good morning. Yesterday: sales $2,400.00, known costs $1,600.00, you kept $800.00. 3 things need you. Ask me about any of them.");
    expect(briefText({locale:"en",currency:"USD",needsOwner:0,
      yesterday:{netSalesCents:100,totalCostsCents:50,ownerProfitCents:50,complete:false}}))
      .toContain("Some costs are still missing, so this is partial. Nothing needs you right now.");
    // A recorded zero-sales day is a result, and a missing currency is said out loud.
    expect(briefText({locale:"en",currency:null,needsOwner:0,
      yesterday:{netSalesCents:0,totalCostsCents:5_000,ownerProfitCents:-5_000,complete:true}}))
      .toContain("Your café currency isn't set, so these amounts have no currency.");
    expect(briefText({locale:"en",currency:"USD",needsOwner:0,yesterday:null,
      verifiedNetSalesCents:139262})).toContain("net sales $1,392.62. Cost coverage is incomplete.");
    expect(briefText({locale:"es",currency:"EUR",needsOwner:0,yesterday:null}))
      .toBe("Buenos días. Las ventas de ayer todavía no han llegado. Nada te necesita ahora mismo.");
  });
});

type Rows=Record<string,unknown>;
function fakeDb(opts:{already?:boolean;thread?:boolean;owners?:string[]}={}){
  const inserts:Rows[]=[];
  const q=(table:string)=>{
    const self:Record<string,unknown>={};
    let scopedOwner:string|null=null;
    for(const m of ["select","order","limit","in","neq"])self[m]=()=>self;
    self.eq=(column:string,value:unknown)=>{
      if((column==="user_id"||column==="owner_user_id")&&typeof value==="string")scopedOwner=value;
      return self;
    };
    self.upsert=async(row:Rows)=>{inserts.push({table,...row});return {error:null};};
    self.update=(row:Rows)=>{inserts.push({table,op:"update",...row});return self;};
    self.range=async()=>({data:table==="businesses"?[{id:"b1",timezone:zone,currency:"USD",is_demo:false},
      {id:"demo",timezone:zone,currency:"USD",is_demo:true}]:
      table==="memberships"?(opts.owners??["u1"]).map(user_id=>({user_id})):[],error:null});
    self.maybeSingle=async()=>({error:null,data:table==="ai_messages"?(opts.already?{id:"x"}:null):
      table==="memberships"?{user_id:scopedOwner??"u1"}:table==="ai_threads"?(opts.thread===false?null:{id:scopedOwner==="u2"?"t2":"t1"}):null});
    self.then=(r:(v:unknown)=>void)=>r({count:2,error:null});
    self.insert=async(row:Rows)=>{inserts.push({table,...row});return {error:null};};
    return self;
  };
  return {db:{from:q} as unknown as SupabaseClient,inserts};
}
describe("sending the daily brief",()=>{
  const morning=new Date("2026-10-29T12:50:00Z");
  beforeEach(()=>vi.clearAllMocks());
  it("posts one supervisor message in the owner's latest thread, never for demo cafés",async()=>{
    const {db,inserts}=fakeDb();
    expect(await sendDailyBriefs(db,morning)).toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(inserts.map(r=>r.table)).toEqual(["ai_messages","operating_tasks","operating_tasks"]);
    expect(inserts[1]).toMatchObject({id:"daily-brief:2026-10-29:u1",kind:"daily_brief",status:"watching",
      payload:{businessDate:"2026-10-28",threadId:"t1"}});
    // The previous day's brief is retired in the inbox.
    expect(inserts[2]).toMatchObject({op:"update",status:"expired"});
    expect(inserts[1]).toMatchObject({payload:{ownerUserId:"u1"}});
    expect(inserts[0]).toMatchObject({id:briefMessageId("b1","2026-10-29","u1"),thread_id:"t1",owner_user_id:"u1",
      role:"supervisor",structured_content:[{type:"text",
        text:"Good morning. Yesterday: sales $2,400.00, known costs $1,600.00, you kept $800.00. 2 things need you. Ask me about any of them."}]});
  });
  it("skips when today's brief was already sent, or the owner has no thread yet",async()=>{
    for(const opts of [{already:true},{thread:false}]){
      const {db,inserts}=fakeDb(opts);
      expect(await sendDailyBriefs(db,morning)).toMatchObject({sent:0,skipped:1});
      expect(inserts).toHaveLength(0);
    }
  });
  it("does nothing outside the morning window",async()=>{
    const {db,inserts}=fakeDb();
    expect(await sendDailyBriefs(db,new Date("2026-10-29T22:00:00Z"))).toEqual({checked:0,sent:0,skipped:0,failed:0});
    expect(inserts).toHaveLength(0);
  });
});
