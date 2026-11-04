import {describe,expect,it,vi,beforeEach} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {briefMessageId,briefExtras} from "./dailyBrief";
import {buildBriefContent,type MorningBriefEvidence} from "@/lib/whatsapp/morningBrief";
// The brief's count comes from the shared inbox reader (tested in lib/attention); this file
// keeps its previous fixture count of 2, and an unreadable inbox when countFails is set.
const inboxCount=vi.hoisted(()=>({fails:false}));
vi.mock("@/lib/attention/getAttentionItems.server",()=>({readCafeNeedsYou:async()=>{
  if(inboxCount.fails)throw new Error("down");return {count:2,newestTask:null};}}));
vi.mock("server-only",()=>({}));
const evidenceMock=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/lib/whatsapp/morningBrief.server",()=>({readBriefEvidence:evidenceMock.read}));
vi.mock("@/lib/whatsapp/morningBriefDelivery.server",()=>({
  eligibleBriefBinding:vi.fn(async()=>({reason:"no_linked_whatsapp_number"})),prepareBoundBrief:vi.fn()}));
const state={profitability:{available:true,value:{netSalesCents:240_000,totalCostsCents:160_000,ownerProfitCents:80_000}},
  businessCosts:{completeness:"complete"}};
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:vi.fn()}));
vi.mock("./cafeState",()=>({SnapshotCafeStateService:class{getHistoricalState=vi.fn(async()=>state);}}));
import {sendDailyBriefs,runCafeBrief} from "./dailyBrief.server";

const zone="America/Los_Angeles";
// Tuesday Nov 3 2026, PST (UTC-8).
const at=(hhmm:string)=>new Date(`2026-11-03T${hhmm}:00-08:00`);
const hours=(open:string|null)=>open===null?null:
  Object.fromEntries(["sun","mon","tue","wed","thu","fri","sat"].map(d=>[d,[[open,"21:00"]]]));
function evidence(o:Partial<MorningBriefEvidence>={}):MorningBriefEvidence{
  return {businessName:"Shop A",currency:"USD",today:"2026-11-03",yesterday:"2026-11-02",
    netSalesCents:240_000,sold:{available:true,linked:[{id:"latte",units:9}],unlinked:[]},
    menu:[{id:"latte",name:"Latte",base_name:null,category:"Espresso"}],categoryLabels:new Map(),
    events:{available:true,items:[],coverage:"complete"},...o};
}
function useEvidence(e:MorningBriefEvidence,posComplete=true){
  evidenceMock.read.mockImplementation(async(_db:unknown,_c:unknown,_d:unknown,now:Date)=>
    ({evidence:e,content:buildBriefContent(e,now),posComplete}));
}

type Row=Record<string,unknown>;
function fakeDb(o:{open?:string|null;already?:boolean;thread?:boolean;owners?:string[];timezone?:string|null;
  countFails?:boolean;locale?:string}={}){
  const writes:Row[]=[],runs:Row[]=[];
  inboxCount.fails=Boolean(o.countFails);
  const q=(table:string)=>{
    const self:Record<string,unknown>={};
    let scopedOwner:string|null=null,countQuery=false;
    for(const m of ["select","order","limit","in","neq","gte"])self[m]=()=>self;
    self.select=(_columns:string,options?:{head?:boolean})=>{countQuery=Boolean(options?.head);return self;};
    self.eq=(column:string,value:unknown)=>{
      if((column==="user_id"||column==="owner_user_id")&&typeof value==="string")scopedOwner=value;
      return self;
    };
    self.range=async()=>({data:table==="businesses"?[
      {id:"b1",name:"Shop A",timezone:o.timezone===undefined?zone:o.timezone,currency:"USD",is_demo:false},
      {id:"demo",name:"Demo",timezone:zone,currency:"USD",is_demo:true}]:
      table==="memberships"?(o.owners??["u1"]).map(user_id=>({user_id})):[],error:null});
    self.maybeSingle=async()=>({error:null,data:
      table==="locations"?{open_hours:hours(o.open===undefined?"06:30":o.open)}:
      table==="ai_messages"?(o.already?{id:"x",business_id:"b1",owner_user_id:scopedOwner??"u1",thread_id:"t1",
        structured_content:[{type:"text",text:"Saved brief."}]}:null):
      table==="memberships"?{user_id:scopedOwner??"u1"}:
      table==="ai_threads"?(o.thread===false?null:{id:"t1"}):
      table==="supervisor_proposals"?(o.locale?{locale:o.locale}:null):
      table==="operating_tasks"&&o.already?{id:"task"}:null});
    self.then=(r:(v:unknown)=>void)=>r(o.countFails&&countQuery?{count:null,error:{message:"down"}}:{count:2,error:null});
    self.upsert=async(row:Row)=>{(table==="morning_brief_runs"?runs:writes).push({table,...row});return {error:null};};
    self.update=(row:Row)=>{writes.push({table,op:"update",...row});return self;};
    self.insert=async(row:Row)=>{writes.push({table,...row});return {error:null};};
    return self;
  };
  return {db:{from:q} as unknown as SupabaseClient,writes,runs};
}
const reasons=(runs:Row[])=>runs.map(r=>[r.owner_key,r.channel,r.outcome,r.step,r.reason]);

describe("daily brief text",()=>{
  it("has one stable message id per café, owner and day",()=>{
    expect(briefMessageId("a","2026-10-29")).toBe(briefMessageId("a","2026-10-29"));
    expect(briefMessageId("a","2026-10-29")).not.toBe(briefMessageId("a","2026-10-30"));
    expect(briefMessageId("a","2026-10-29","u1")).not.toBe(briefMessageId("a","2026-10-29","u2"));
    expect(briefMessageId("a","2026-10-29")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("adds yesterday's costs in the café currency and what needs the owner, never a guessed count",()=>{
    const costs={totalCostsCents:160_000,ownerProfitCents:80_000,complete:true};
    expect(briefExtras({locale:"en",currency:"USD",needsOwner:3,costs}))
      .toBe("Known costs yesterday: $1,600.00. You kept $800.00. 3 things need you. Ask me about any of them.");
    expect(briefExtras({locale:"en",currency:"USD",needsOwner:0,costs:{...costs,complete:false}}))
      .toBe("Known costs yesterday: $1,600.00. You kept $800.00. Some costs are still missing, so this is partial. Nothing needs you right now.");
    expect(briefExtras({locale:"es",currency:"EUR",needsOwner:0,costs:null}))
      .toBe("Nada te necesita ahora mismo.");
    // An unreadable count says nothing, never "nothing needs you".
    expect(briefExtras({locale:"en",currency:"USD",needsOwner:null,costs:null})).toBe("");
  });
});

describe("sending the daily brief at each café's own time",()=>{
  beforeEach(()=>{vi.clearAllMocks();useEvidence(evidence());});
  it("posts one supervisor message in the owner's latest thread as soon as data is in, never for demo cafés",async()=>{
    const {db,writes,runs}=fakeDb();
    expect(await sendDailyBriefs(db,at("05:00"))).toEqual({checked:1,sent:1,skipped:0,failed:0});
    expect(writes.map(r=>r.table)).toEqual(["ai_messages","operating_tasks","operating_tasks"]);
    expect(writes[0]).toMatchObject({id:briefMessageId("b1","2026-11-03","u1"),thread_id:"t1",owner_user_id:"u1",
      role:"supervisor"});
    // No WhatsApp set up: the in-app brief is still the full brief, plus costs and what needs the owner.
    const text=(writes[0].structured_content as Array<{text:string}>)[0].text;
    expect(text).toContain("Net sales: $2,400.00");
    expect(text).toContain("Drinks sold: 9 items in total (drink split not ready yet)");
    expect(text).toContain("Best seller: Latte, with 9 sold");
    expect(text).toContain("Today: No major events near you this week.");
    expect(text.endsWith("Known costs yesterday: $1,600.00. You kept $800.00. 2 things need you. Ask me about any of them.")).toBe(true);
    expect(writes[1]).toMatchObject({id:"daily-brief:2026-11-03:u1",kind:"daily_brief",
      payload:{businessDate:"2026-11-02",threadId:"t1",ownerUserId:"u1"}});
    expect(writes[2]).toMatchObject({op:"update",status:"expired"});
    expect(reasons(runs)).toEqual([["u1","in_app","sent","in_app","posted"],
      ["u1","whatsapp","skipped","whatsapp","whatsapp_not_configured"]]);
  });
  it("café opening at 6:30 sends before 6:30; café opening at 9:00 sends before 9:00; unknown hours by 6:00",async()=>{
    useEvidence(evidence(),false); // POS still syncing: each café waits until its own send-anyway time.
    const cases:Array<[string|null,string,boolean]>=[
      ["06:30","05:40",false],["06:30","05:45",true],
      ["09:00","06:00",false],["09:00","08:15",true],
      [null,"05:40",false],[null,"05:45",true]];
    for(const [open,time,sends] of cases){
      const {db,writes}=fakeDb({open});
      await sendDailyBriefs(db,at(time));
      expect([open,time,writes.some(w=>w.table==="ai_messages")]).toEqual([open,time,sends]);
    }
    // 9:00 café is not even checked at 05:00.
    expect(await sendDailyBriefs(fakeDb({open:"09:00"}).db,at("05:00"))).toEqual({checked:0,sent:0,skipped:0,failed:0});
  });
  it("late sync: waits with a recorded reason, then sends by the latest send time with what it has",async()=>{
    useEvidence(evidence({netSalesCents:null,sold:{available:false,linked:[],unlinked:[]}}),false);
    const waiting=fakeDb();
    await sendDailyBriefs(waiting.db,at("05:10"));
    expect(waiting.writes).toHaveLength(0);
    expect(reasons(waiting.runs)).toEqual([["cafe","in_app","waiting","pos_sync","yesterday_pos_data_not_complete"]]);
    const fallback=fakeDb();
    expect(await sendDailyBriefs(fallback.db,at("05:50"))).toMatchObject({sent:1});
    expect(fallback.writes[0]).toMatchObject({structured_content:[{type:"text",
      text:expect.stringContaining("Net sales: not in yet (your POS is still syncing)")}]});
    // Missed the cron until 06:10: still sent, marked late, before the 06:30 opening.
    const late=fakeDb();
    expect(await sendDailyBriefs(late.db,at("06:10"))).toMatchObject({sent:1});
    expect(late.runs.find(r=>r.channel==="in_app")?.details).toMatchObject({phase:"late"});
  });
  it("every skip writes a reason",async()=>{
    const cases:Array<[ReturnType<typeof fakeDb>,string,string]>=[
      [fakeDb({owners:[]}),"owners","no_owner"],
      [fakeDb({thread:false}),"thread","no_chat_thread"],
      [fakeDb({timezone:null}),"schedule","no_timezone"],
      [fakeDb({timezone:"No/Such_Zone"}),"schedule","invalid_timezone"],
    ];
    for(const [{db,runs},step,reason] of cases){
      await sendDailyBriefs(db,at("05:50"));
      expect(runs.find(r=>r.step===step)).toMatchObject({outcome:"skipped",reason});
    }
    const missed=fakeDb();
    await sendDailyBriefs(missed.db,at("06:45"));
    expect(reasons(missed.runs)).toContainEqual(["u1","in_app","skipped","schedule","missed_send_window"]);
    useEvidence(evidence({netSalesCents:null,sold:{available:false,linked:[],unlinked:[]},
      events:{available:false,items:[],coverage:null}}));
    const nothing=fakeDb();
    await sendDailyBriefs(nothing.db,at("05:50"));
    expect(nothing.writes).toHaveLength(0);
    expect(nothing.runs[0]).toMatchObject({step:"content",outcome:"skipped",reason:"nothing_to_say",
      details:{missing:["sales_not_in","items_not_in","events_unavailable"]}});
  });
  it("an unreadable attention count never becomes 'nothing needs you'",async()=>{
    const {db,writes}=fakeDb({countFails:true});
    expect(await sendDailyBriefs(db,at("05:00"))).toMatchObject({sent:1});
    const text=(writes[0].structured_content as Array<{text:string}>)[0].text;
    expect(text).not.toContain("Nothing needs you");
    expect(text).not.toContain("things need you");
    expect(text).toContain("Net sales: $2,400.00");
  });
  it("owners in Spanish get the full brief in Spanish; an event-only day keeps its event",async()=>{
    const es=fakeDb({locale:"es"});
    await sendDailyBriefs(es.db,at("05:00"));
    const text=(es.writes[0].structured_content as Array<{text:string}>)[0].text;
    expect(text).toContain("Ventas netas de ayer: 2400,00");
    expect(text).toContain("No hay eventos importantes cerca esta semana.");
    expect(text).toContain("Latte");
    const night={id:"e1",name:"Night market",kind:"festival",startDate:"2026-11-03",endDate:"2026-11-03",
      startTime:null,endTime:null,venue:null,venueAddress:null,areaLabel:null,sourceUrl:null,
      status:"found" as const,foundAt:"2026-11-01T00:00:00Z",lastCheckedAt:"2026-11-01T00:00:00Z"};
    useEvidence(evidence({netSalesCents:null,sold:{available:false,linked:[],unlinked:[]},
      events:{available:true,items:[night],coverage:"complete"}}));
    const only=fakeDb();
    await sendDailyBriefs(only.db,at("05:50"));
    expect((only.writes[0].structured_content as Array<{text:string}>)[0].text)
      .toContain("Today: Night market (not confirmed yet)");
  });
  it("exactly one brief per café, owner and local date",async()=>{
    const {db,writes}=fakeDb({already:true});
    expect(await sendDailyBriefs(db,at("05:50"))).toMatchObject({sent:0,skipped:1});
    expect(writes).toHaveLength(0);
  });
  it("a test run skips only the time-of-day rule",async()=>{
    const early=fakeDb();
    const r=await runCafeBrief(early.db,{id:"b1",name:"Shop A",timezone:zone,currency:"USD"},at("02:00"),{kind:"test"});
    expect(r.owners[0].inApp).toMatchObject({outcome:"sent",reason:"posted"});
    expect(early.runs.every(x=>x.run_kind==="test")).toBe(true);
  });
});
