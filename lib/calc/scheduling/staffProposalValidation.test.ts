import {describe,it,expect} from "vitest";
import {assertStaffShiftPlan,formatStaffShiftWithBreak} from "./staffProposalValidation";
const s={employee_id:"maria",date:"2026-10-26",start:"06:30",end:"12:00",break_minutes:30};
describe("staff approval scheduling validation",()=>{
 it("permits a prep shift before opening and nonoverlapping shifts",()=>{
  expect(()=>assertStaffShiftPlan([s,{...s,start:"12:00",end:"16:00"}])).not.toThrow();
 });
 it("rejects overlapping employee shifts and shifts with impossible breaks",()=>{
  expect(()=>assertStaffShiftPlan([s,{...s,start:"11:00",end:"14:00"}])).toThrow(/Overlapping/);
  expect(()=>assertStaffShiftPlan([{...s,start:"08:00",end:"08:15",break_minutes:30}])).toThrow(/break/);
 });
 it("detects retained Sunday overnight against next Monday replacement",()=>{
  const sunday={...s,date:"2026-11-01",start:"20:00",end:"02:00"};
  const monday={...s,date:"2026-11-02",start:"01:00",end:"08:00"};
  expect(()=>assertStaffShiftPlan([monday,sunday])).toThrow(/Overlapping/);
  expect(()=>assertStaffShiftPlan([{...monday,start:"02:00"},sunday])).not.toThrow();
 });
 it("detects overlap across midnight",()=>{
  expect(()=>assertStaffShiftPlan([{...s,start:"22:00",end:"02:00",date:"2026-10-26"},
   {...s,start:"01:00",end:"05:00",date:"2026-10-27"}])).toThrow(/Overlapping/);
 });
});

import {formatStaffApprovalRuleValue} from "./staffProposalValidation";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
describe("localized staff rule approval values",()=>{
 it.each([en,es,ar])("never renders raw true or false for boolean rules",(catalog)=>{
  const copy=catalog.StaffApprovalCard;
  expect(formatStaffApprovalRuleValue(true,copy)).toBe(copy.ruleEnabled);
  expect(formatStaffApprovalRuleValue(false,copy)).toBe(copy.ruleDisabled);
  expect(formatStaffApprovalRuleValue(true,copy)).not.toBe("true");
  expect(formatStaffApprovalRuleValue(false,copy)).not.toBe("false");
 });
 it("leaves numeric values and missing values meaningful",()=>{
  const copy=en.StaffApprovalCard;
  expect(formatStaffApprovalRuleValue(0,copy)).toBe("0");
  expect(formatStaffApprovalRuleValue(null,copy)).toBe("—");
 });
});

describe("schedule approval break disclosure",()=>{
 it("distinguishes shifts with the same hours but different unpaid breaks",()=>{
  const shift={date:"2026-11-02",start:"09:00",end:"17:00",break_minutes:30};
  const before=formatStaffShiftWithBreak(shift,"min unpaid break");
  const after=formatStaffShiftWithBreak({...shift,break_minutes:240},"min unpaid break");
  expect(before).toContain("30 min unpaid break");
  expect(after).toContain("240 min unpaid break");
  expect(before).not.toBe(after);
 });
});
