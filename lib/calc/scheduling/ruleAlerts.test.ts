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

 it("handles skipped midnight in America/Santiago without dropping the schedule",()=>{
  const r={meal_break_enabled:false,meal_break_minutes:30,meal_break_after_minutes:300,
   rest_break_enabled:false,rest_break_minutes:10,rest_break_every_minutes:240,
   weekly_ot_enabled:false,weekly_ot_after_minutes:2400,daily_ot_enabled:true,daily_ot_after_minutes:180,
   min_rest_enabled:false,min_rest_minutes:600,max_shift_enabled:false,max_shift_minutes:600,
   min_shift_enabled:false,min_shift_minutes:180};
  const night={id:"night",employeeId:"amy",start:"2026-09-06T02:00:00Z",
   end:"2026-09-06T06:00:00Z",breaks:[]};
  const day={id:"day",employeeId:"amy",start:"2026-09-06T06:00:00Z",
   end:"2026-09-06T08:00:00Z",breaks:[]};
  expect(()=>checkTimecardRules([night,day],r,"America/Santiago")).not.toThrow();
  expect(checkTimecardRules([night,day],r,"America/Santiago")
   .filter(x=>x.key==="daily_overtime").map(x=>x.timecardId)).toEqual(["day"]);
 });
 it("accumulates split shifts in each business-local day",()=>{
  const r={meal_break_enabled:false,meal_break_minutes:30,meal_break_after_minutes:300,
   rest_break_enabled:false,rest_break_minutes:10,rest_break_every_minutes:240,
   weekly_ot_enabled:false,weekly_ot_after_minutes:2400,daily_ot_enabled:true,daily_ot_after_minutes:480,
   min_rest_enabled:false,min_rest_minutes:600,max_shift_enabled:false,max_shift_minutes:600,
   min_shift_enabled:false,min_shift_minutes:180};
  const a={id:"split-a",employeeId:"amy",start:"2026-10-27T14:00:00Z",end:"2026-10-27T19:00:00Z",breaks:[]};
  const b={...a,id:"split-b",start:"2026-10-27T20:00:00Z",end:"2026-10-28T01:00:00Z"};
  const daily=checkTimecardRules([a,b],r,"America/Los_Angeles").filter(v=>v.key==="daily_overtime");
  expect(daily).toEqual([{timecardId:"split-b",employeeId:"amy",key:"daily_overtime",details:expect.any(String)}]);
 });
 it("does not assign an overnight shift's hours to its starting day",()=>{
  const r={meal_break_enabled:false,meal_break_minutes:30,meal_break_after_minutes:300,
   rest_break_enabled:false,rest_break_minutes:10,rest_break_every_minutes:240,
   weekly_ot_enabled:false,weekly_ot_after_minutes:2400,daily_ot_enabled:true,daily_ot_after_minutes:480,
   min_rest_enabled:false,min_rest_minutes:600,max_shift_enabled:false,max_shift_minutes:600,
   min_shift_enabled:false,min_shift_minutes:180};
  const overnight={id:"night",employeeId:"amy",start:"2026-10-27T05:00:00Z",
   end:"2026-10-27T13:00:00Z",breaks:[]};
  expect(checkTimecardRules([overnight],r,"America/Los_Angeles").some(v=>v.key==="daily_overtime")).toBe(false);
  const second={id:"morning",employeeId:"amy",start:"2026-10-27T14:00:00Z",
   end:"2026-10-27T18:00:00Z",breaks:[]};
  const out=checkTimecardRules([overnight,second],r,"America/Los_Angeles");
  expect(out.filter(v=>v.key==="daily_overtime").map(v=>v.timecardId)).toEqual(["morning"]);
 });
 it("subtracts the unpaid break on its actual local day",()=>{
  const r={meal_break_enabled:false,meal_break_minutes:30,meal_break_after_minutes:300,
   rest_break_enabled:false,rest_break_minutes:10,rest_break_every_minutes:240,
   weekly_ot_enabled:false,weekly_ot_after_minutes:2400,daily_ot_enabled:true,daily_ot_after_minutes:360,
   min_rest_enabled:false,min_rest_minutes:600,max_shift_enabled:false,max_shift_minutes:600,
   min_shift_enabled:false,min_shift_minutes:180};
  const shifts=[{id:"shift",employeeId:"amy",start:"2026-10-27T14:00:00Z",end:"2026-10-27T21:00:00Z",
    breaks:[{start:"2026-10-27T17:00:00Z",end:"2026-10-27T18:30:00Z",paid:false}]}];
  expect(checkTimecardRules(shifts,r,"America/Los_Angeles").some(v=>v.key==="daily_overtime")).toBe(false);
 });
});
