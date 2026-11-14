import {describe,expect,it} from "vitest";
import {choosePriorities,priorityRevision} from "./priority";
import type {PrioritySource} from "./contracts";
const base:PrioritySource={
  businessId:"cafebusiness",ownerUserId:"owner",sourceType:"alert",
  sourceId:"source-a",kind:"missing_bill",status:"new",
  createdAt:"2026-11-09T01:00:00Z",evidence:{quality:"partial",lastCheckedAt:"before"},
};
describe("proactive priority ranking and source revision",()=>{
  it("always ranks critical operational evidence above ordinary overdue owner work",()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    const critical={...base,sourceId:"urgent-sales",severity:"critical" as const,
      evidence:{verified:true,metric:"sales_drop"}};
    const overdue={...base,sourceId:"ordinary-overdue",
      sourceType:"operating_task" as const,kind:"review",
      status:"needs_owner",dueAt:"2026-11-01T00:00:00Z",
      confidence:"high",severity:null};
    expect(choosePriorities([overdue,critical],now,2).map(x=>x.source.sourceId))
      .toEqual(["urgent-sales","ordinary-overdue"]);
  });
  it("keeps high-severity work above routine needs without inventing impact",()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    const high={...base,sourceId:"high-risk",severity:"high" as const,
      evidence:{quality:"partial"}};
    const ordinary={...base,sourceId:"normal",
      sourceType:"operating_task" as const,kind:"review",status:"needs_owner",
      dueAt:"2026-11-01T00:00:00Z"};
    const ranked=choosePriorities([ordinary,high],now,2);
    expect(ranked[0].source.sourceId).toBe("high-risk");
    expect(ranked[0].reason).toBe("Actionable café alert needs review");
  });
  it("does not generate a new notice for incidental poll/seen changes",()=>{
    expect(priorityRevision(base)).toBe(priorityRevision({
      ...base,status:"seen",evidence:{lastCheckedAt:"after",quality:"partial"},
    }));
  });
  it("distinguishes material task action changes but not alert seen status",()=>{
    const task={...base,sourceType:"operating_task" as const,
      status:"needs_response",kind:"supply_check"};
    expect(priorityRevision(task)).not.toBe(priorityRevision({...task,status:"needs_owner"}));
  });
  it("does regenerate for meaningful evidence correction",()=>{
    expect(priorityRevision(base)).not.toBe(priorityRevision({
      ...base,evidence:{quality:"verified"},
    }));
  });
  it("orders overdue owner needs before routine informational alerts",()=>{
    const decisions=choosePriorities([base,{
      ...base,sourceId:"task",sourceType:"operating_task",kind:"staff_coverage",
      status:"needs_owner",dueAt:"2026-11-08T00:00:00Z",
    }],new Date("2026-11-11T00:00:00Z"));
    expect(decisions.map(d=>d.source.sourceId)).toEqual(["task","source-a"]);
    expect(decisions[0].reason).toBe("Overdue item needs review");
  });
  it("cannot claim missing data is zero or invent an impact",()=>{
    const [decision]=choosePriorities([{...base,evidence:null,confidence:"unknown"}],
      new Date("2026-11-11T00:00:00Z"));
    expect(decision.reason).toBe("Actionable café alert needs review");
    expect(JSON.stringify(decision)).not.toContain("dollars");
  });
  it("does not re-notify Events, reminders, or notices already delivered by their writer",()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    const duplicateKinds=["event_plan","event_change","event_report",
      "commitment","priority_notice"];
    const rows=duplicateKinds.map((kind,index)=>({
      ...base,sourceType:"operating_task" as const,kind,status:"needs_owner",
      sourceId:"prior-delivery-"+index,
    }));
    expect(choosePriorities(rows,now,10)).toEqual([]);
    expect(choosePriorities([...rows,{...base,sourceType:"operating_task",
      sourceId:"unrelated-review",kind:"data_quality",status:"needs_owner"}],now,10)
      .map(x=>x.source.sourceId)).toEqual(["unrelated-review"]);
  });
  it("ignores closed tasks and differs by owner/café",()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    expect(choosePriorities([{...base,status:"resolved"}],now)).toEqual([]);
    expect(choosePriorities([base],now)[0].stableKey)
      .not.toBe(choosePriorities([{...base,ownerUserId:"other"}],now)[0].stableKey);
  });
});
