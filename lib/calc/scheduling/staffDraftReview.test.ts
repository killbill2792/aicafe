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
  it("does not allow an unrecognized worker into a draft",()=>{
    expect(()=>reviewStaffDraft([{employee_id:"other",date:"2026-10-26",
      start:"08:00",end:"12:00",break_minutes:0}],[person],rules,[],"UTC"))
      .toThrow("draft_person_not_found");
  });
});
