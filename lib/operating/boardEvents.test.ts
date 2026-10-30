import {describe,expect,it} from "vitest";
import {buildOperatingBoard,boardHref,type BoardProposalRow} from "./board";

const eventPlan:BoardProposalRow={
  id:"event-plan",thread_id:"event-thread",capability_id:"alex.event_readiness.v1",
  status:"committed",monitoring_start_date:"2026-10-31",
  monitor_spec:{durationDays:2},
  canonical_effect_payload:{summary:"Halloween readiness",startDate:"2026-10-31",
    endDate:"2026-11-01",actions:[{action:"Prepare hot drinks"}]},
};
describe("event readiness on the shared Operating Board",()=>{
  it("shows a committed event plan from the same Supervisor proposal row",()=>{
    const board=buildOperatingBoard([eventPlan],[],"2026-10-30");
    expect(board.running).toMatchObject([{proposalId:"event-plan",threadId:"event-thread",
      event:true,productName:"Halloween readiness",day:0,days:2}]);
    expect(boardHref(board.running[0])).toBe("/?thread=event-thread");
  });
  it("shows final event reports from the existing supervisor_reports ledger",()=>{
    const board=buildOperatingBoard([eventPlan],[{
      proposal_id:"event-plan",status:"complete",generated_at:"2026-11-02T12:00:00Z",
      report:{recommendation:"adjust"},
    }],"2026-11-03");
    expect(board.recentReports).toMatchObject([{
      proposalId:"event-plan",event:true,productName:"Halloween readiness",status:"complete",
    }]);
  });
  it("does not invent an event plan when the saved effect has no summary",()=>{
    expect(buildOperatingBoard([{...eventPlan,canonical_effect_payload:{}}],[],"2026-10-30").running).toEqual([]);
  });
});
