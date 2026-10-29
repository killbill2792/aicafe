import {describe,expect,it,vi} from "vitest";
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("@/lib/ai/supervisor/loop/sales.server",()=>({readPriceExperimentBaselineUnits:vi.fn(),readPriceExperimentSalesDays:vi.fn()}));
import {boardHref,buildOperatingBoard,DRINK_PRICE_EXPERIMENT_CAPABILITY,type BoardProposalRow} from "./board";
import {priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";

const effect={productId:"x",productName:"Latte",oldPriceCents:450,newPriceCents:475};
const row=(id:string,status:string,start:string|null,extra:Partial<BoardProposalRow>={}):BoardProposalRow=>({
  id,thread_id:"t-"+id,status,capability_id:"alex.drink_price_experiment.v1",canonical_effect_payload:effect,
  monitor_spec:{durationDays:7,metricScope:"product"},monitoring_start_date:start,...extra});

describe("Operating Board",()=>{
  it("shows monitoring day X of Y and price changes waiting on the owner",()=>{
    const board=buildOperatingBoard([row("a","committed","2026-10-27"),row("b","manual_pending",null)],[],"2026-10-29");
    expect(board.running).toEqual([
      {proposalId:"a",threadId:"t-a",capabilityId:"alex.drink_price_experiment.v1",productName:"Latte",oldPriceCents:450,newPriceCents:475,stage:"monitoring",day:3,days:7},
      {proposalId:"b",threadId:"t-b",capabilityId:"alex.drink_price_experiment.v1",productName:"Latte",oldPriceCents:450,newPriceCents:475,stage:"waitingOnOwner",day:null,days:null},
    ]);
  });
  it("drops finished windows, drafts and rows without a price effect",()=>{
    const board=buildOperatingBoard([row("a","committed","2026-10-01"),row("b","draft",null),
      row("c","committed","2026-10-28",{canonical_effect_payload:{}}),row("d","monitored","2026-10-01")],[],"2026-10-29");
    expect(board.running).toEqual([]);
  });
  it("lists recent final reports newest first with the recommendation",()=>{
    const proposals=[row("a","monitored","2026-10-10"),row("b","monitored","2026-10-12"),row("c","monitored","2026-09-01")];
    const board=buildOperatingBoard(proposals,[
      {proposal_id:"a",status:"complete",report:{recommendation:"keep"},generated_at:"2026-10-20T16:30:00Z"},
      {proposal_id:"b",status:"insufficient_evidence",report:{recommendation:"adjust"},generated_at:"2026-10-25T16:30:00Z"},
      {proposal_id:"c",status:"complete",report:{recommendation:"keep"},generated_at:"2026-09-10T16:30:00Z"},
      {proposal_id:"zz",status:"complete",report:{},generated_at:"2026-10-28T16:30:00Z"},
    ],"2026-10-29");
    expect(board.recentReports.map(r=>[r.proposalId,r.status,r.recommendation]))
      .toEqual([["b","insufficient_evidence","adjust"],["a","complete","keep"]]);
  });
  it("uses the registered drink experiment capability id",()=>{
    expect(DRINK_PRICE_EXPERIMENT_CAPABILITY).toBe(priceExperimentCapabilityId);
  });
  it("links a drink experiment to its panel and any other monitor to its thread",()=>{
    expect(boardHref({threadId:"t1",proposalId:"p1",capabilityId:"alex.drink_price_experiment.v1"}))
      .toBe("/?thread=t1&experiment=p1");
    expect(boardHref({threadId:"t2",proposalId:"p2",capabilityId:"alex.menu_price_change.v1"}))
      .toBe("/?thread=t2");
  });
  it("shows at most three of each",()=>{
    const rows=["a","b","c","d"].map(id=>row(id,"manual_pending",null));
    expect(buildOperatingBoard(rows,[],"2026-10-29").running).toHaveLength(3);
  });
  it("shows a goal by its title, with day X of Y, and its met/not met report",()=>{
    const g=(id:string,status:string,start:string|null)=>({id,thread_id:"t-"+id,status,capability_id:"leo.goal.v1",
      canonical_effect_payload:{title:"Average ticket up 5%"},monitor_spec:{durationDays:30,metricScope:"goal:avg_ticket"},
      monitoring_start_date:start});
    const board=buildOperatingBoard([g("a","committed","2026-10-20"),g("b","monitored","2026-09-01")],
      [{proposal_id:"b",status:"complete",report:{recommendation:"keep",evaluationStatus:"met"},generated_at:"2026-10-25T16:30:00Z"}],
      "2026-10-29");
    expect(board.running).toEqual([{proposalId:"a",threadId:"t-a",capabilityId:"leo.goal.v1",productName:"Average ticket up 5%",
      oldPriceCents:0,newPriceCents:0,goal:true,stage:"monitoring",day:10,days:30}]);
    expect(board.recentReports[0]).toMatchObject({proposalId:"b",goal:{met:true}});
    expect(boardHref(board.running[0])).toBe("/?thread=t-a");
  });
});
