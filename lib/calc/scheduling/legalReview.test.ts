import {describe,expect,it} from "vitest";
import type {PlannerInput} from "./plannerTypes";
import {isOliviaLegalReviewComplete} from "./legalReview";
const input:PlannerInput={
  horizonStart:"2026-10-12",locations:[{id:"a",timezone:"UTC"}],
  employees:[{id:"worker",displayName:"Worker",active:true,
    recurring:[],exceptions:[],qualifications:[],
    wage:{wage_period:"hour",wage_amount_cents:1000,
      default_hourly_wage_cents:null},provenance:"known_paid"}],
  coverage:[],
};
const validProfile={
  verified:true,source:"Reviewed jurisdiction rule source",
  jurisdictionByLocationId:{a:"Jurisdiction 1"},
  classificationByEmployeeId:{worker:"Hourly worker"},
  maxContinuousWorkMinutes:360,unpaidMealMinutes:30,
  paidRestMinutes:0,minRestBetweenShiftsMinutes:600,
  overtime:{verified:true,dailyAfterMinutes:480,
    weeklyAfterMinutes:2400,multiplierNumerator:3,
    multiplierDenominator:2},
};
describe("Olivia owner-reviewed legal source completeness",()=>{
  it("does not make up a legal-review state from missing metadata",()=>{
    expect(isOliviaLegalReviewComplete(input)).toBe(false);
  });
  it("requires reviewed jurisdictions, worker classifications and overtime source",()=>{
    expect(isOliviaLegalReviewComplete({...input,ruleProfile:{
      ...validProfile,classificationByEmployeeId:{},
    }})).toBe(false);
    expect(isOliviaLegalReviewComplete({...input,ruleProfile:{
      ...validProfile,jurisdictionByLocationId:{},
    }})).toBe(false);
    expect(isOliviaLegalReviewComplete({...input,ruleProfile:{
      ...validProfile,overtime:{...validProfile.overtime,verified:false},
    }})).toBe(false);
  });
  it("recognizes structurally complete sourced owner-reviewed profile",()=>{
    expect(isOliviaLegalReviewComplete({...input,ruleProfile:validProfile})).toBe(true);
  });
});
