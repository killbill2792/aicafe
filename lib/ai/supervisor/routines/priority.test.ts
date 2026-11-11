import {describe,expect,it} from "vitest";
import {choosePriorities,priorityRevision} from "./priority";
import type {PrioritySource} from "./contracts";
const base:PrioritySource={
  businessId:"cafebusiness",ownerUserId:"owner",sourceType:"alert",
  sourceId:"source-a",kind:"missing_bill",status:"new",
  createdAt:"2026-11-09T01:00:00Z",evidence:{quality:"partial",lastCheckedAt:"before"},
};
describe("proactive priority ranking and source revision",()=>{
  it("does not generate a new notice for incidental poll/seen changes",()=>{
    expect(priorityRevision(base)).toBe(priorityRevision({
      ...base,status:"seen",evidence:{lastCheckedAt:"after",quality:"partial"},
    }));
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
  it("ignores closed tasks and differs by owner/café",()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    expect(choosePriorities([{...base,status:"resolved"}],now)).toEqual([]);
    expect(choosePriorities([base],now)[0].stableKey)
      .not.toBe(choosePriorities([{...base,ownerUserId:"other"}],now)[0].stableKey);
  });
});
