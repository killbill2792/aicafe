import {describe,expect,it} from "vitest";
import {checkNumbers} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

const goal:AgentToolResult={source:"goals",period:null,missing:[],goal:{id:"g0000000-0000-4000-8000-000000000001"},
  metricDetail:{id:"primary",metricKey:"avg_ticket",source:"computed",params:{},unit:"cents",
    comparator:"gte",targetKind:"relative_pct",target:5},
  metricEvaluation:{current:840,baseline:800,target:840,coverage:1}};
describe("goal numbers in the chat reply",()=>{
  it("accepts the goal's own average ticket, before-period value, target and percent",()=>{
    expect(checkNumbers("Average ticket is $8.40 vs $8.00 before, on the 5% target of $8.40.","",[goal],"en")).toEqual([]);
  });
  it("still rejects a number no tool returned",()=>{
    expect(checkNumbers("Average ticket is $9.10.","",[goal],"en")).not.toEqual([]);
  });
});
