import {describe,expect,it} from "vitest";
import {buildOperatingBoard,type BoardProposalRow} from "./board";

const effect={productId:"x",productName:"Latte",oldPriceCents:450,newPriceCents:475};
const row=(id:string,status:string,start:string|null,extra:Partial<BoardProposalRow>={}):BoardProposalRow=>({
  id,thread_id:"t-"+id,status,capability_id:"price_experiment",canonical_effect_payload:effect,
  monitor_spec:{durationDays:7,metricScope:"product"},monitoring_start_date:start,...extra});

describe("Operating Board",()=>{
  it("shows monitoring day X of Y and price changes waiting on the owner",()=>{
    const board=buildOperatingBoard([row("a","committed","2026-10-27"),row("b","manual_pending",null)],[],"2026-10-29");
    expect(board.running).toEqual([
      {proposalId:"a",threadId:"t-a",productName:"Latte",oldPriceCents:450,newPriceCents:475,stage:"monitoring",day:3,days:7},
      {proposalId:"b",threadId:"t-b",productName:"Latte",oldPriceCents:450,newPriceCents:475,stage:"waitingOnOwner",day:null,days:null},
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
  it("shows at most three of each",()=>{
    const rows=["a","b","c","d"].map(id=>row(id,"manual_pending",null));
    expect(buildOperatingBoard(rows,[],"2026-10-29").running).toHaveLength(3);
  });
});
