import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const reads=vi.hoisted(()=>({
  daily:vi.fn(),sold:vi.fn(),menu:vi.fn(),events:vi.fn(),coverage:vi.fn(),labels:vi.fn(),
}));
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFactRows:reads.daily}));
vi.mock("@/lib/data/periodItemSales.server",()=>({readPeriodSoldLines:reads.sold}));
vi.mock("@/lib/data/menuCatalog.server",()=>({readMenuCatalogRows:reads.menu}));
vi.mock("@/lib/data/cafeEvents.server",()=>({readCafeEvents:reads.events,readCityResearchCoverage:reads.coverage}));
vi.mock("@/lib/data/menuCategoryLabels.server",()=>({readMenuCategoryLabels:reads.labels}));
import {readBriefEvidence} from "./morningBrief.server";

const db={} as SupabaseClient,now=new Date("2026-11-03T13:50:00Z");
const cafe={businessId:"cafe-a",businessName:"Shop A",currency:"USD"};
const day={today:"2026-11-03",yesterday:"2026-11-02"};
beforeEach(()=>{
  vi.clearAllMocks();
  reads.daily.mockResolvedValue([{business_date:"2026-11-02",net_sales_cents:10900,sales_data_status:"actual"}]);
  reads.sold.mockResolvedValue({available:true,linked:[{id:"latte",units:3},{id:"cookie",units:9}],unlinked:[]});
  reads.menu.mockResolvedValue([{id:"latte",name:"Latte",base_name:"Latte",category:"ESPRESSO_DRINK"},
    {id:"cookie",name:"Cookie",base_name:"Cookie",category:"PASTRY"}]);
  reads.labels.mockResolvedValue(new Map());
  reads.events.mockResolvedValue([]);
  reads.coverage.mockResolvedValue({status:"complete"});
});
describe("morning brief evidence",()=>{
  it("reads the canonical sources for yesterday and the coming week, in the café's scope",async()=>{
    const r=await readBriefEvidence(db,cafe,day,now);
    expect(r.posComplete).toBe(true);
    expect(r.content.items).toMatchObject({mode:"drinks",drinks:3,total:12,best:{name:"Latte",units:3}});
    expect(r.content.netSales.text).toBe("$109.00");
    expect(r.content.event.line).toBe("No major events near you this week.");
    expect(reads.daily).toHaveBeenCalledWith(db,"cafe-a","2026-11-02","2026-11-02");
    expect(reads.sold).toHaveBeenCalledWith(db,"cafe-a",{from:"2026-11-02",to:"2026-11-02"});
    expect(reads.events).toHaveBeenCalledWith(db,"cafe-a","2026-11-03","2026-11-10");
    expect(reads.coverage).toHaveBeenCalledWith(db,"cafe-a","2026-11-03","2026-11-10");
  });
  it("a failing or unfinished source is 'missing', never a skipped brief",async()=>{
    reads.daily.mockResolvedValueOnce([{business_date:"2026-11-02",net_sales_cents:10900,sales_data_status:"missing"}]);
    reads.events.mockRejectedValueOnce(new Error("events down"));
    reads.menu.mockRejectedValueOnce(new Error("menu down"));
    reads.labels.mockRejectedValueOnce(new Error("labels down"));
    const r=await readBriefEvidence(db,cafe,day,now);
    expect(r.posComplete).toBe(false);
    expect(r.content.hasSomethingToSay).toBe(true);
    expect(r.content.missing).toEqual(expect.arrayContaining(["sales_not_in","events_unavailable"]));
    expect(r.content.items.mode).toBe("all_items"); // items still counted, by an unknown-name fallback
  });
  it("POS is complete only with certified sales AND covered items",async()=>{
    reads.sold.mockResolvedValueOnce({available:false,linked:[],unlinked:[]});
    expect((await readBriefEvidence(db,cafe,day,now)).posComplete).toBe(false);
    reads.daily.mockResolvedValueOnce([]);
    expect((await readBriefEvidence(db,cafe,day,now)).posComplete).toBe(false);
  });
});
