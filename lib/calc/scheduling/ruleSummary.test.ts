import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {ruleThresholdStatus} from "./ruleSummary";

describe("Team summary matches enabled scheduling rules",()=>{
 it("shows enabled meal and weekly OT thresholds, including odd minutes",()=>{
  expect(ruleThresholdStatus(true,337)).toEqual({enabled:true,hours:5,minutes:37});
  expect(ruleThresholdStatus(true,2400)).toEqual({enabled:true,hours:40,minutes:0});
 });
 it("never exposes a disabled rule's stored threshold",()=>{
  expect(ruleThresholdStatus(false,300)).toEqual({enabled:false});
  expect(ruleThresholdStatus(false,2400)).toEqual({enabled:false});
  expect(ruleThresholdStatus(false,0)).toEqual({enabled:false});
 });
 it("wires both actual business flags and all three locale messages into the Team view",()=>{
  const component=readFileSync(join(process.cwd(),"components/staff/TeamLegacyMetrics.tsx"),"utf8");
  expect(component).toContain("rules.data.meal_break_enabled");
  expect(component).toContain("rules.data.weekly_ot_enabled");
  expect(component).toContain('tRules("mealRuleSummaryOff")');
  expect(component).toContain('tRules("weeklyRuleSummaryOff")');
  for(const lang of ["en","es","ar"]){
   const message=JSON.parse(readFileSync(join(process.cwd(),"messages",lang+".json"),"utf8")).StaffSchedule;
   for(const key of ["mealRuleSummaryOn","mealRuleSummaryOff","weeklyRuleSummaryOn","weeklyRuleSummaryOff"]){
    expect(typeof message[key]).toBe("string");
    expect(message[key].length).toBeGreaterThan(2);
   }
   for(const key of ["mealRuleSummaryOn","weeklyRuleSummaryOn"]){
    expect(message[key]).toContain("{hours}");
    expect(message[key]).toContain("{minutes}");
   }
  }
 });
});
