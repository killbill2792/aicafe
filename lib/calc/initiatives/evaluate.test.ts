import { describe,expect,it } from "vitest";
import { evaluateInitiative,type GoalMetric } from "./evaluate";
const series=(days:Array<[string,number|null,number?]>)=>
  days.map(([date,value,coverage=1])=>({date,value,coverage}));
const base=series([["2026-10-01",100],["2026-10-08",100]]);
const test=series([["2026-10-15",110],["2026-10-22",120]]);
const goal=(o:Partial<GoalMetric>={}):GoalMetric=>({
  id:"primary",role:"primary",comparator:"gte",targetKind:"relative_pct",target:5,
  baseline:base,test,...o,
});
describe("M1 weekday-matched evaluator",()=>{
  it("evaluates goal with no operational change",()=>{
    const result=evaluateInitiative([goal()],"2026-10-16","2026-10-22",0.8,"goal");
    expect(result.status).toBe("on_track");
    expect(result.results.primary.target).toBe(105);
  });
  it("evaluates price-like higher margin and lower order volume guardrail",()=>{
    const g=goal({id:"orders_guardrail",role:"guardrail",comparator:"gte",targetKind:"relative_pct",target:-10,
      baseline:base,test:series([["2026-10-15",70]])});
    const result=evaluateInitiative([goal(),g],"2026-10-15","2026-10-22");
    expect(result.status).toBe("off_track");
    expect(result.recommendation).toBe("revert");
  });
  it("evaluates same-weekday shift-like per-hour sales",()=>{
    const result=evaluateInitiative([goal({targetKind:"absolute",target:115})],"2026-10-22","2026-10-22");
    expect(result.status).toBe("met");
  });
  it("supports check-in-only absolute target without inventing a prior value",()=>{
    const checkin=goal({source:"checkin",targetKind:"absolute",target:1,
      baseline:[],test:series([["2026-10-15",1]])});
    const result=evaluateInitiative([checkin],"2026-10-15","2026-10-22");
    expect(result.status).toBe("on_track");
    expect(result.results.primary.baseline).toBeNull();
  });
  it("does not convert absent persisted sample days into full coverage",()=>{
    const onlyOne=goal({test:series([["2026-10-15",120]]),
      expectedTestDates:["2026-10-15","2026-10-16","2026-10-17","2026-10-18"]});
    const result=evaluateInitiative([onlyOne],"2026-10-18","2026-10-22");
    expect(result.status).toBe("insufficient_data");
    expect(result.results.primary.coverage).toBe(0.25);
  });
  it("keeps missing data insufficient rather than passing",()=>{
    const incomplete=goal({test:series([["2026-10-15",null,0]])});
    expect(evaluateInitiative([incomplete],"2026-10-15","2026-10-22").status).toBe("insufficient_data");
  });
  it("detects guardrail breach and lower-is-better cost goals",()=>{
    const cost=goal({comparator:"lte",targetKind:"absolute",target:95,test:series([["2026-10-15",90]])});
    expect(evaluateInitiative([cost],"2026-10-22","2026-10-22").status).toBe("met");
    const breached=goal({id:"guard",role:"guardrail",comparator:"lte",targetKind:"absolute",target:90,
      test:series([["2026-10-15",120]])});
    expect(evaluateInitiative([goal(),breached],"2026-10-15","2026-10-22").status).toBe("off_track");
  });
  it("supports absolute targets without fabricated weekday baselines",()=>{
    const complete=goal({targetKind:"absolute",target:100,baseline:[],test:series([
      ["2026-10-15",200],["2026-10-16",200],["2026-10-17",200],
      ["2026-10-18",200],["2026-10-19",200],["2026-10-20",200],["2026-10-21",200],
    ]),expectedTestDates:["2026-10-15","2026-10-16","2026-10-17",
      "2026-10-18","2026-10-19","2026-10-20","2026-10-21"]});
    const r=evaluateInitiative([complete],"2026-10-21","2026-10-21");
    expect(r.status).toBe("met");
    expect(r.results.primary.baseline).toBeNull();
    expect(r.results.primary.coverage).toBe(1);
  });
  it("requires baseline evidence on the same weekday",()=>{
    const mismatch=goal({baseline:series([["2026-10-14",100]])});
    expect(evaluateInitiative([mismatch],"2026-10-15","2026-10-22").status).toBe("insufficient_data");
  });
});
