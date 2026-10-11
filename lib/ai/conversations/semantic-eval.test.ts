import {describe,expect,it} from "vitest";
import cases from "./semantic-eval.fixture.json";
import {SUPERVISOR_FUNCTIONS} from "./supervisorFunctions.mjs";
import {matchesAcceptablePlan} from "./semanticEval";
describe("Live semantic eval fixture integrity ONLY (no model inference in CI)",()=>{
  it("covers distinct capabilities, varied language, follow-up context and strict complete-plan matching",()=>{
    expect(cases.length).toBeGreaterThan(30);
    const known=new Set(SUPERVISOR_FUNCTIONS.map(x=>x.name));
    for(const c of cases){
      expect(c.question.trim()).toBeTruthy();
      expect(c.acceptablePlans.length).toBeGreaterThan(0);
      for(const plan of c.acceptablePlans){
        expect(plan.length).toBeGreaterThan(0);
        for(const item of plan)expect(known.has(item.name)).toBe(true);
      }
    }
    expect(matchesAcceptablePlan([{name:"get_sales",arguments:{}}],[
      [{name:"get_sales"},{name:"get_team"}]])).toBe(false);
    expect(matchesAcceptablePlan([{name:"get_sales",arguments:{}},{name:"get_team",arguments:{}}],[
      [{name:"get_sales"},{name:"get_team"}]])).toBe(true);
  });
});
