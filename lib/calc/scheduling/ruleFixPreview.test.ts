import {describe,it,expect} from "vitest";
import {isStaffRuleKey,suggestedRuleShiftChange} from "./ruleFixPreview";
const rules={meal_break_minutes:30,weekly_ot_after_minutes:2400,daily_ot_after_minutes:480};
const shift={start:"07:15",end:"17:15",minutes:600,breakMinutes:0,paidMinutes:600};
describe("owner-preview rule suggestions",()=>{
 it("suggests an unpaid meal break without persisting it",()=>{
  expect(suggestedRuleShiftChange("meal",shift,rules,600,600)).toEqual({start:"07:15",end:"17:15",breakMinutes:30});
 });
 it("only trims scheduled overtime when the current schedule exceeds a limit",()=>{
  expect(suggestedRuleShiftChange("daily_overtime",shift,rules,600,600)).toEqual({start:"07:15",end:"15:15",breakMinutes:0});
  expect(suggestedRuleShiftChange("weekly_overtime",shift,rules,600,2460)).toEqual({start:"07:15",end:"16:15",breakMinutes:0});
  expect(suggestedRuleShiftChange("weekly_overtime",shift,rules,600,2300)).toBeNull(); 
  expect(suggestedRuleShiftChange("weekly_overtime",shift,{...rules,weekly_ot_enabled:false},600,2460)).toBeNull();
 });
 it("does not make up a paid rest fix or shorten an unrelated timecard",()=>{
  expect(suggestedRuleShiftChange("rest_break",shift,rules,600,600)).toBeNull();
  expect(suggestedRuleShiftChange("short_rest",shift,rules,600,600)).toBeNull();
  expect(suggestedRuleShiftChange("daily_overtime",{...shift,breakMinutes:599},rules,600,600)).toBeNull();
  expect(isStaffRuleKey("sql")).toBe(false);
 });
});
