import {describe,it,expect} from "vitest";
import {dedupeAlerts} from "./ruleAlerts";
import {checkTimecardRules} from "./ruleChecks";
describe("missed-rule alert deduplication",()=>{
 it("keeps one alert per timecard and rule across overlapping scans",()=>{
  const violation={timecardId:"t1",employeeId:"e1",key:"meal" as const,details:"Missed meal"};
  const rest={...violation,key:"rest_break" as const};
  expect(dedupeAlerts([violation,violation,rest,violation])).toEqual([violation,rest]);
 });
 it("uses café timezone when determining overtime week",()=>{
  const rules={meal_break_enabled:false,meal_break_minutes:30,meal_break_after_minutes:300,
    rest_break_enabled:false,rest_break_minutes:10,rest_break_every_minutes:240,
    weekly_ot_enabled:true,weekly_ot_after_minutes:90,daily_ot_enabled:false,daily_ot_after_minutes:480,
    min_rest_enabled:false,min_rest_minutes:600,max_shift_enabled:false,max_shift_minutes:600,
    min_shift_enabled:false,min_shift_minutes:180};
  const events=[
   {id:"a",employeeId:"e",start:"2026-10-26T06:30:00Z",end:"2026-10-26T07:30:00Z",breaks:[]},
   {id:"b",employeeId:"e",start:"2026-10-26T14:00:00Z",end:"2026-10-26T15:00:00Z",breaks:[]}
  ];
  expect(checkTimecardRules(events,rules,"America/Los_Angeles").filter(v=>v.key==="weekly_overtime")).toHaveLength(0);
  expect(checkTimecardRules(events,rules,"UTC").filter(v=>v.key==="weekly_overtime")).toHaveLength(1);
 });
});
