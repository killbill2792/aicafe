import {describe,it,expect} from "vitest";
import {reviewStaffDraft} from "./staffDraftReview";
import type {RuleSettings} from "./ruleChecks";
import type {PersonForSchedule} from "./schedulePresentation";

const rules={
  weekly_ot_enabled:false,weekly_ot_after_minutes:2400,min_rest_enabled:false,
  min_rest_minutes:600,max_shift_enabled:false,min_shift_enabled:false,
  daily_ot_enabled:false,
} as RuleSettings;
const person={id:"11111111-1111-4111-8111-111111111111",name:"Ava",
  role:"Barista",wageCents:1873,availableDays:[0,1,2,3,4,5,6],
  minWeeklyMinutes:null,maxWeeklyMinutes:null,colorIndex:0,active:true} satisfies PersonForSchedule;
describe("in-place Olivia draft review",()=>{
  it("shows exact paid minutes and integer-cents wages without saving shifts",()=>{
    const row={employee_id:person.id,date:"2026-10-26",start:"08:00",end:"12:00",break_minutes:30};
    const reviewed=reviewStaffDraft([row],[person],rules,[],"America/Los_Angeles");
    expect(reviewed.totals.shiftCount).toBe(1);
    expect(reviewed.totals.paidMinutes).toBe(210);
    expect(reviewed.totals.knownCostCents).toBe(6556);
    expect(reviewed.shifts[0].id).toBe("olivia-0");
    expect(reviewed.totals.unknownCount).toBe(0);
  });
  it("marks unpriced shifts as unknown, not zero-cost labor",()=>{
    const reviewed=reviewStaffDraft([{employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"12:00",break_minutes:0}],[{...person,wageCents:null}],
      rules,[],"America/Los_Angeles");
    expect(reviewed.totals.unknownCount).toBe(1);
    expect(reviewed.shifts[0].costCents).toBeNull();
  });
  it("uses the trusted hourly rate instead of stale team wage",()=>{
    const reviewed=reviewStaffDraft([{employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"09:00",break_minutes:0}],
      [person],rules,[],"UTC",[],{[person.id]:2500});
    expect(reviewed.totals.knownCostCents).toBe(2500);
    expect(reviewed.totals.estimatedCount).toBe(0);
  });
  it("never guesses a cost when trusted compensation is absent",()=>{
    const reviewed=reviewStaffDraft([{employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"09:00",break_minutes:0}],
      [person],rules,[],"UTC",[],{[person.id]:null});
    expect(reviewed.totals.unknownCount).toBe(1);
    expect(reviewed.totals.knownCostCents).toBe(0);
  });
  it("rejects duplicate and invalid draft shifts before presenting an approval",()=>{
    const row={employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"09:00",break_minutes:0};
    expect(()=>reviewStaffDraft([row,row],[person],rules,[],"UTC")).toThrow("Overlapping shifts");
    expect(()=>reviewStaffDraft([{...row,end:"08:00"}],[person],rules,[],"UTC"))
      .toThrow("draft_invalid_shift");
  });
  it("counts a missed configured meal break as a rule issue",()=>{
    const mealRules={...rules,meal_break_enabled:true,meal_break_minutes:30,
      meal_break_after_minutes:300};
    const reviewed=reviewStaffDraft([{employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"14:00",break_minutes:0}],[person],mealRules,[],"UTC");
    expect(reviewed.totals.ruleIssues).toBeGreaterThanOrEqual(1);
  });
  it("surfaces uncovered minimum staffing as a rule issue",()=>{
    const reviewed=reviewStaffDraft([{employee_id:person.id,date:"2026-10-26",
      start:"08:00",end:"10:00",break_minutes:0}],[person],rules,[],"UTC",
      [],undefined,{dates:["2026-10-26"],openHours:{mon:[["08:00","10:00"]]},minHeadcount:2});
    expect(reviewed.totals.coverageGaps).toBe(1);
    expect(reviewed.totals.ruleIssues).toBeGreaterThanOrEqual(1);
  });
  it("does not allow an unrecognized worker into a draft",()=>{
    expect(()=>reviewStaffDraft([{employee_id:"other",date:"2026-10-26",
      start:"08:00",end:"12:00",break_minutes:0}],[person],rules,[],"UTC"))
      .toThrow("draft_person_not_found");
  });
});
