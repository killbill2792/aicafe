import {previewShift,type DetailedShift,type PersonForSchedule,type AvailabilityEntry} from "./schedulePresentation";
import {shiftCost,roleWageAverages,businessWageEstimate} from "./shiftCost";
import type {RuleSettings} from "./ruleChecks";
import {assertStaffShiftPlan} from "./staffProposalValidation";

export type StaffDraftInputShift={
  employee_id:string;date:string;start:string;end:string;break_minutes:number
};
export type StaffDraftShift=StaffDraftInputShift&{
  id:string;name:string;paidMinutes:number;costCents:number|null;estimated:boolean;unknown:boolean
};
export type StaffDraftTotals={
  shiftCount:number;paidMinutes:number;knownCostCents:number;
  unknownCount:number;estimatedCount:number;ruleIssues:number
};

/** UI preview only: server approval independently validates and commits the canonical effect. */
export function reviewStaffDraft(
  shifts:readonly StaffDraftInputShift[],
  people:PersonForSchedule[],rules:RuleSettings,
  availability:AvailabilityEntry[],timezone:string,adjacent:DetailedShift[]=[],
  wageRates?:Record<string,number|null>
):{shifts:StaffDraftShift[];totals:StaffDraftTotals}{
  assertStaffShiftPlan(shifts);
  if(shifts.some(s=>s.start===s.end))throw new Error("draft_invalid_shift");
  const roleAverages=roleWageAverages(people),businessAverage=businessWageEstimate(people);
  const projected=shifts.map((s,index)=>{
    const person=people.find(p=>p.id===s.employee_id);
    if(!person)throw new Error("draft_person_not_found");
    const trustedWage=wageRates!==undefined&&Object.hasOwn(wageRates,person.id);
    const cost=shiftCost({employeeId:person.id,date:s.date,start:s.start,end:s.end,
      breakMinutes:s.break_minutes,overnight:s.end<s.start,
      wageCents:trustedWage?wageRates?.[person.id]??null:person.wageCents,role:person.role},
      trustedWage?null:person.role?roleAverages.get(person.role.toLowerCase())??null:null,
      trustedWage?null:businessAverage);
    return {...cost,id:"olivia-"+index,employeeName:person.name,status:"draft"} satisfies DetailedShift;
  });
  let ruleIssues=0;
  const flaggedWeekly=new Set<string>(),flaggedMax=new Set<string>();
  for(const shift of projected){
    const check=previewShift({employeeId:shift.employeeId,date:shift.date,start:shift.start,
      end:shift.end,breakMinutes:shift.breakMinutes,editingId:shift.id},
      people,projected,[],availability,rules,timezone,adjacent);
    if(!check)throw new Error("draft_invalid_shift");
    ruleIssues+=Number(check.tooLong)+Number(check.tooShort)+
      Number(check.shortRest)+Number(check.overlapDetected)+
      Number(check.availability==="off"||check.availability==="unavailable")+
      Number(rules.meal_break_enabled&&shift.minutes>rules.meal_break_after_minutes&&
        shift.breakMinutes<rules.meal_break_minutes)+
      Number(rules.daily_ot_enabled&&shift.paidMinutes>rules.daily_ot_after_minutes);
    if(check.aboveMaximum)flaggedMax.add(shift.employeeId);
    if(check.overtime)flaggedWeekly.add(shift.employeeId);
  }
  ruleIssues+=flaggedMax.size+flaggedWeekly.size;
  return {
    shifts:projected.map(s=>({employee_id:s.employeeId,date:s.date,start:s.start,end:s.end,
      break_minutes:s.breakMinutes,id:s.id,name:s.employeeName??"",paidMinutes:s.paidMinutes,
      costCents:s.costCents,estimated:s.estimated,unknown:s.unknown})),
    totals:{shiftCount:projected.length,paidMinutes:projected.reduce((n,s)=>n+s.paidMinutes,0),
      knownCostCents:projected.reduce((n,s)=>n+(s.costCents??0),0),
      unknownCount:projected.filter(s=>s.unknown).length,
      estimatedCount:projected.filter(s=>s.estimated&&!s.unknown).length,ruleIssues}
  };
}
