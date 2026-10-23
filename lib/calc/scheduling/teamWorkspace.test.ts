import {describe,it,expect} from "vitest";
import {shiftCost,aggregateCosts,paidMinutes,businessWageEstimate,costCompleteness,missingWageInputs} from "./shiftCost";
import {coverageGaps} from "./coverageGaps";
import {automaticUnpaidBreakMinutes,checkScheduledWeeklyBounds,checkTimecardRules} from "./ruleChecks";
const rules={meal_break_enabled:true,meal_break_minutes:30,meal_break_after_minutes:300,
 rest_break_enabled:true,rest_break_minutes:10,rest_break_every_minutes:240,
 weekly_ot_enabled:true,weekly_ot_after_minutes:2400,daily_ot_enabled:false,
 daily_ot_after_minutes:480,min_rest_enabled:true,min_rest_minutes:600,
 max_shift_enabled:true,max_shift_minutes:600,min_shift_enabled:true,min_shift_minutes:180};
describe("staff schedule truth",()=>{
 it("matches the mockup weekly paid hours/cost and shift addition",()=>{
   const minutes=[1470,1470,1200,1470,1470,1050,780];
   expect(minutes.reduce((a,b)=>a+b,0)).toBe(8910);
   const lines=minutes.flatMap((m,day)=>Array.from({length:m/30},(_,i)=>
     shiftCost({employeeId:i<22?"premium":"other",date:"2026-10-"+String(26+day).padStart(2,"0"),
       start:"10:00",end:"10:30",breakMinutes:0,wageCents:i<22&&day===0?2700:1900})));
   // 148.5 h at $19, with 11 premium hours at +$8/h.
   expect(aggregateCosts(lines).knownCostCents).toBe(290950);
   const amy=shiftCost({employeeId:"Amy",date:"2026-10-28",
     start:"10:00",end:"16:30",breakMinutes:30,wageCents:1850});
   expect(amy.paidMinutes).toBe(360);
   expect(amy.costCents).toBe(11100);
   expect(aggregateCosts([...lines,amy]).knownCostCents).toBe(302050);
 });
 it("keeps missing pay clearly estimated, never counts unknown wage as zero",()=>{
   const input={employeeId:"x",date:"2026-10-28",start:"09:00",end:"15:00",breakMinutes:30,wageCents:null};
   expect(shiftCost(input,1850)).toMatchObject({costCents:10175,estimated:true,unknown:false});
   expect(shiftCost(input)).toMatchObject({costCents:null,estimated:true,unknown:true});
   expect(paidMinutes(input)).toBe(330);
   expect(businessWageEstimate([{wageCents:2000},{wageCents:null},{wageCents:2400}])).toBe(2200);
   expect(shiftCost(input,null,2200)).toMatchObject({costCents:12100,estimated:true,unknown:false});
   expect(costCompleteness(aggregateCosts([shiftCost(input)]))).toBe("unknown");
   expect(missingWageInputs(aggregateCosts([shiftCost(input)]))).toEqual(["wagesUnknownForSomeShifts"]);
   expect(missingWageInputs(aggregateCosts([shiftCost({...input,wageCents:2000})]))).toEqual([]);
   expect(costCompleteness(aggregateCosts([shiftCost(input),shiftCost({...input,wageCents:2000})]))).toBe("partial");
   expect(costCompleteness(aggregateCosts([shiftCost({...input,wageCents:2000})]))).toBe("complete");
 });
 it("computes sub-day coverage gaps and doesn't fabricate hours for unknown days",()=>{
   const open={wed:[["07:00","16:00"]],sun:[["07:00","15:00"]]} as const;
   const shifts=[
     {employeeId:"1",date:"2026-10-28",start:"07:00",end:"16:00",breakMinutes:0,wageCents:1800},
     {employeeId:"2",date:"2026-10-28",start:"07:00",end:"14:30",breakMinutes:0,wageCents:1800},
     {employeeId:"1",date:"2026-11-01",start:"07:00",end:"15:00",breakMinutes:0,wageCents:1800},
     {employeeId:"2",date:"2026-11-01",start:"07:00",end:"13:30",breakMinutes:0,wageCents:1800}];
   expect(coverageGaps(["2026-10-28","2026-11-01"],shifts,{wed:open.wed.map(([start,end]):[string,string]=>[start,end]),sun:open.sun.map(([start,end]):[string,string]=>[start,end])},2))
     .toMatchObject([{start:"14:30",end:"16:00"},{start:"13:30",end:"15:00"}]);
 });
 it("derives automatic unpaid breaks only when the owner's configured rule applies",()=>{
   const custom={...rules,meal_break_after_minutes:360,meal_break_minutes:45};
   expect(automaticUnpaidBreakMinutes("09:00","14:00",custom)).toBe(0);
   expect(automaticUnpaidBreakMinutes("09:00","09:00",custom)).toBe(0);
   expect(automaticUnpaidBreakMinutes("09:00","15:30",custom)).toBe(45);
   expect(automaticUnpaidBreakMinutes("22:00","05:00",custom)).toBe(45);
   expect(automaticUnpaidBreakMinutes("09:00","15:30",{...custom,meal_break_enabled:false})).toBe(0);
 });
 it("only applies entered weekly limits",()=>{
   expect(checkScheduledWeeklyBounds(2400,null,null)).toEqual({belowMinimum:false,aboveMaximum:false});
   expect(checkScheduledWeeklyBounds(2400,2500,2300)).toEqual({belowMinimum:true,aboveMaximum:true});
 });
 it("flags recorded missed breaks, weekly overtime and short rest",()=>{
   const entry=(id:string,start:string,end:string)=>({id,employeeId:"Amy",start,end,breaks:[]});
   const output=checkTimecardRules([
     entry("m","2026-10-19T06:00:00Z","2026-10-19T18:00:00Z"),
     entry("t","2026-10-20T01:00:00Z","2026-10-20T13:00:00Z"),
     entry("w","2026-10-21T02:00:00Z","2026-10-21T14:00:00Z"),
     entry("th","2026-10-22T03:00:00Z","2026-10-22T13:00:00Z"),
   ],rules).map(r=>r.key);
   expect(output).toContain("meal");
   expect(output).toContain("rest_break");
   expect(output).toContain("short_rest");
   expect(output).toContain("weekly_overtime");
 });
});
