import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const reads=vi.hoisted(()=>({
  daily:vi.fn(),items:vi.fn(),menu:vi.fn(),events:vi.fn(),monitors:vi.fn(),
}));
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFactRows:reads.daily}));
vi.mock("@/lib/data/periodItemSales.server",()=>({readPeriodItemSales:reads.items}));
vi.mock("@/lib/data/menuCatalog.server",()=>({readMenuCatalogRows:reads.menu}));
vi.mock("@/lib/data/cafeEvents.server",()=>({readCafeEvents:reads.events}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:reads.monitors}));
import {readPreparedMorningBrief} from "./morningBrief.server";

const db={} as SupabaseClient,now=new Date("2026-10-31T15:30:00Z");
const recipient={
  businessId:"cafe-a",ownerUserId:"owner-a",businessName:"Shop A",currency:"USD",
  today:"2026-10-31",yesterday:"2026-10-30",timezone:"America/Los_Angeles",
  verifiedBinding:true,followupPermitted:true,
};
beforeEach(()=>{
  vi.clearAllMocks();
  reads.daily.mockResolvedValue([{business_date:"2026-10-30",net_sales_cents:10900,
    sales_data_status:"actual"}]);
  reads.items.mockResolvedValue({covered:true,soldItems:[{id:"latte",units:3},{id:"cookie",units:9}]});
  reads.menu.mockResolvedValue([{id:"latte",name:"Latte",base_name:"Latte",category:"ESPRESSO_DRINK"},
    {id:"cookie",name:"Cookie",base_name:"Cookie",category:"PASTRY"}]);
  reads.events.mockResolvedValue([{
    id:"event-1",name:"Festival",kind:"festival",startDate:"2026-10-31",endDate:"2026-10-31",
    venue:"Downtown",startTime:"10:00:00",sourceUrl:"https://example.com/festival",
    lastVerifiedAt:"2026-10-31T10:00:00Z",status:"found",
  }]);
  reads.monitors.mockResolvedValue([{
    id:"monitor-1",status:"committed",monitoring_start_date:"2026-10-31",
    monitor_spec:{metricScope:"same_weekday_sales",durationDays:2},
  }]);
});
describe("canonical morning-brief reader",()=>{
  it("reads canonical sources in the exact café, owner and local day scope",async()=>{
    const result=await readPreparedMorningBrief(db,recipient,now);
    expect(result?.parameters).toEqual(["Shop A","$109.00","3","Latte","3",
      "Festival at Downtown at 10:00","Saturday"]);
    expect(reads.daily).toHaveBeenCalledWith(db,"cafe-a","2026-10-30","2026-10-30");
    expect(reads.items).toHaveBeenCalledWith(db,"cafe-a",{from:"2026-10-30",to:"2026-10-30"});
    expect(reads.menu).toHaveBeenCalledWith(db,"cafe-a");
    expect(reads.events).toHaveBeenCalledWith(db,"cafe-a","2026-10-31","2026-10-31");
    expect(reads.monitors).toHaveBeenCalledWith(db,{businessId:"cafe-a",ownerUserId:"owner-a"},
      {statuses:["committed","manual_confirmed"],limit:100});
    expect(result?.provenance.sales).toBe("daily_rollups");
  });
  it("never reads or exposes a café when the verified binding or followup consent fails",async()=>{
    expect(await readPreparedMorningBrief(db,{...recipient,verifiedBinding:false},now)).toBeNull();
    expect(await readPreparedMorningBrief(db,{...recipient,followupPermitted:false},now)).toBeNull();
    expect(await readPreparedMorningBrief(db,{...recipient,today:"2026-11-01"},now)).toBeNull();
    expect(await readPreparedMorningBrief(db,{...recipient,timezone:"No/Valid_Zone"},now)).toBeNull();
    for(const read of Object.values(reads))expect(read).not.toHaveBeenCalled();
  });
  it("skips partial sales, uncovered Toast items and unverified event/monitor facts",async()=>{
    reads.daily.mockResolvedValueOnce([{business_date:"2026-10-30",
      net_sales_cents:10900,sales_data_status:"missing"}]);
    expect(await readPreparedMorningBrief(db,recipient,now)).toBeNull();
    reads.items.mockResolvedValueOnce({covered:false,soldItems:[{id:"latte",units:3}]});
    expect(await readPreparedMorningBrief(db,recipient,now)).toBeNull();
    reads.monitors.mockResolvedValueOnce([]);
    expect(await readPreparedMorningBrief(db,recipient,now)).toBeNull();
    reads.events.mockResolvedValueOnce([]);
    expect(await readPreparedMorningBrief(db,recipient,now)).toBeNull();
  });
});
