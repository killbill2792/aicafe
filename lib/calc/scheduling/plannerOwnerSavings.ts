import {optimizeOliviaWeek} from "./plannerEngine";
import {workerWageRate} from "./plannerCore";
import type {PlannerEmployee,PlannerInput,PlannerShift} from "./plannerTypes";

export const HYPOTHETICAL_OWNER_ID="hypothetical-owner-zero-pay";
/** Read-only assumption: an owner who says they are unpaid can work
 * unqualified coverage slots for up to 8 h/day and 40 h/week. Existing
 * required certifications are NEVER attributed to the owner.
 */
export function modelUnpaidOwnerWhatIf(input:PlannerInput){
 const baseline=optimizeOliviaWeek(input);
 const hypothetical:PlannerEmployee={
  id:HYPOTHETICAL_OWNER_ID,displayName:"Owner (hypothetical)",
  active:true,isOwner:true,ownerOpportunityCentsPerHour:null,
  recurring:Array.from({length:7},(_,day)=>({
   day_of_week:day,start_local:"00:00",end_local:"23:59",
   overnight:false,effective_from:input.horizonStart,effective_to:null,
   confirmation:"owner_confirmed" as const
  })),
  exceptions:[],preferences:[],qualifications:[],
  minWeeklyMinutes:0,maxDailyMinutes:480,maxWeeklyMinutes:2400,
  wage:{wage_period:"hour",wage_amount_cents:0,default_hourly_wage_cents:0},
  provenance:"known_eligible_zero",eligibleZeroVerified:true
 };
 const modeled=optimizeOliviaWeek({...input,employees:[...input.employees,hypothetical]});
 const base=baseline.scenarios.find(s=>s.objective==="cash")??baseline.best;
 const candidate=modeled.scenarios.find(s=>s.objective==="cash")??modeled.best;
 const valid=Boolean(base?.completeCoverage&&base.hardConstraintsSatisfied&&
  candidate?.completeCoverage&&candidate.hardConstraintsSatisfied);
 const savingsCents=valid&&base?.cost.cashWagesCents!=null&&candidate?.cost.cashWagesCents!=null?
  base.cost.cashWagesCents-candidate.cost.cashWagesCents:null;
 const shifts=(candidate?.shifts??[]).filter(s=>s.employeeId===HYPOTHETICAL_OWNER_ID);
 const replacementRows=shifts.map(shift=>{
  // Only an exact baseline shift match can certify a per-shift wage replacement;
  // the total cost comparison above covers reassignments and split shifts.
  const old=base?.shifts.find(original=>original.locationId===shift.locationId&&
   original.startAt===shift.startAt&&original.endAt===shift.endAt&&
   original.employeeId!==HYPOTHETICAL_OWNER_ID);
  const worker=old&&input.employees.find(e=>e.id===old.employeeId);
  return {locationId:shift.locationId,startAt:shift.startAt,endAt:shift.endAt,
   paidMinutes:shift.paidMinutes,baselineWorker:worker?.displayName??null,
   baselineHourlyWageCents:worker?workerWageRate(worker):null};
 });
 return {baselineCashWagesCents:base?.cost.cashWagesCents??null,
  withOwnerCashWagesCents:candidate?.cost.cashWagesCents??null,
  savingsCents, ownerMinutes:candidate?.ownerMinutes??0,replacementRows,
  completeCoverage:valid,
  assumptions:["Owner says they take zero wages","Owner is hypothetically available across the week for up to 8 hours/day and 40 hours/week",
   "Owner has no assumed professional certifications; qualified slots are not assigned to them",
   "Owner time/opportunity cost is excluded; this is modeled payroll savings, not profit",
   "Olivia searches feasible rosters but does not prove a global maximum"],
  warnings:[...baseline.warnings,...modeled.warnings]};
}
