import { expandPlannerInput, isConfirmedAvailable, qualifies, baselineGapReason,
  type DemandUnit, type WorkUnit } from "./plannerCore";
import { parseUtcInstant, utcIso } from "./plannerClock";
import { costForWork, hardValid } from "./plannerRules";
import type { PlannerCost, PlannerGap, PlannerInput, PlannerShift } from "./plannerTypes";

export type PlannerValidation = {
  valid: boolean;
  completeCoverage: boolean;
  violations: string[];
  gaps: PlannerGap[];
  cost: PlannerCost | null;
  /** An exhausted matching budget is never treated as proof of infeasibility. */
  matchingBudgetExhausted: boolean;
};
function coveredBy(works: readonly WorkUnit[],unit:DemandUnit, employeeId:string) {
  const pieces=works.filter(w=>w.employeeId===employeeId &&
    w.locationId===unit.locationId && w.end>unit.start && w.start<unit.end)
    .sort((a,b)=>a.start-b.start);
  let end=unit.start;
  for(const work of pieces){
    if(work.start>end)return false;
    end=Math.max(end,work.end);
    if(end>=unit.end)return true;
  }
  return false;
}
function markGap(unit:DemandUnit,reason:PlannerGap["reason"]):PlannerGap {
  return {coverageId:unit.coverageId,locationId:unit.locationId,
    startAt:utcIso(unit.start),endAt:utcIso(unit.end),
    missingHeadcount:1,qualificationCode:unit.qualificationCode,reason};
}
/** Independent PR3-compatible pure feasibility validator for a proposed
 * draft roster. No publication, employee acceptance, payroll or DB writes.
 * This rejects untrusted shifts with missing breaks, ghost qualifications,
 * unconfirmed availability, pinned deletions, or coverage double-counting.
 */
export function validateOliviaAssignments(input:PlannerInput,
  proposal:readonly PlannerShift[]):PlannerValidation {
  const plan=expandPlannerInput(input);
  const violations:string[]=[];
  const gaps:PlannerGap[]=[];
  const work:WorkUnit[]=[];
  const interval=input.slotMinutes??30;
  if(proposal.length>2000)throw new Error("invalid_planner_input:too_many_shifts");
  for(const shift of proposal){
    try {
      if(!plan.employees.some(e=>e.id===shift.employeeId) ||
        !plan.locations.has(shift.locationId))
        throw new Error("unknown_employee_or_location");
      const start=parseUtcInstant(shift.startAt);
      const end=parseUtcInstant(shift.endAt);
      if(end<=start || (end-start)% (interval*60000)!==0 || end-start>24*3_600_000)
        throw new Error("invalid_shift_interval");
      const breaks=shift.unpaidBreaks.map(b=>({
        start:parseUtcInstant(b.startAt),end:parseUtcInstant(b.endAt),paid:b.paid,
      })).sort((a,b)=>a.start-b.start);
      let last=start,unpaid=0;
      for(const brk of breaks){
        if(brk.paid!==false || brk.start<last || brk.end<=brk.start ||
          brk.end>end || (brk.end-brk.start)%(interval*60000)!==0)
          throw new Error("invalid_unpaid_break");
        last=brk.end;unpaid+=(brk.end-brk.start)/60000;
        if(input.ruleProfile?.unpaidMealMinutes!=null &&
          (brk.end-brk.start)/60000<input.ruleProfile.unpaidMealMinutes)
          throw new Error("meal_shorter_than_configured_minimum");
      }
      if(!Number.isSafeInteger(shift.paidMinutes) ||
        shift.paidMinutes!==(end-start)/60000-unpaid)
        throw new Error("paid_minutes_mismatch");
      for(let t=start;t<end;t+=interval*60000){
        if(breaks.some(b=>b.start<t+interval*60000 && b.end>t))continue;
        work.push({employeeId:shift.employeeId,locationId:shift.locationId,
          start:t,end:t+interval*60000,pinned:false});
      }
    }catch(error){
      violations.push(error instanceof Error?error.message:"invalid_shift");
    }
  }
  const cache=new Map<string,Array<{start:number;end:number}>>();
  for(const piece of work){
    const employee=plan.employees.find(e=>e.id===piece.employeeId);
    if(employee && !isConfirmedAvailable(piece,employee,plan.locations,cache)){
      violations.push("outside_confirmed_availability:"+piece.employeeId+":"+utcIso(piece.start));
    }
  }
  if(!hardValid(work,plan,input))violations.push("overlap_rest_or_hour_cap_violation");
  for(const pin of plan.pinned){
    if(!work.some(w=>w.employeeId===pin.employeeId&&w.locationId===pin.locationId &&
      w.start<=pin.start && w.end>=pin.end))
      violations.push("pinned_commitment_removed:"+pin.employeeId+":"+utcIso(pin.start));
  }
  // Matching must allocate a distinct qualified worker to simultaneous
  // requirements. A single worker cannot be credited twice to different
  // headcount slots (even across overlapping roles or locations).
  const candidates=plan.units.map(unit=>
    plan.employees.filter(e=>qualifies(e,unit,plan.locations) &&
      coveredBy(work,unit,e.id)).map(e=>e.id).sort());
  // Advisory coverage is a soft preference, not a hard publish gate.
  const indices=plan.units.map((_,i)=>i)
    .filter(i=>plan.units[i].priority==="required").sort((a,b)=>
    candidates[a].length-candidates[b].length ||
    plan.units[a].start-plan.units[b].start ||
    plan.units[a].id.localeCompare(plan.units[b].id));
  const chosen=new Map<number,string>();
  let nodes=0,exhausted=false;
  function match(position:number):boolean {
    if(position===indices.length)return true;
    if(nodes>=30000){exhausted=true;return false;}
    const index=indices[position],unit=plan.units[index];
    for(const id of candidates[index]){
      nodes++;
      if([...chosen].some(([prior,emp])=>emp===id &&
        plan.units[prior].start<unit.end && unit.start<plan.units[prior].end))continue;
      chosen.set(index,id);
      if(match(position+1))return true;
      chosen.delete(index);
      if(exhausted)return false;
    }
    return false;
  }
  const satisfied=match(0);
  if(!satisfied){
    const shortfall=indices.filter(i=>candidates[i].length===0);
    for(const index of shortfall)gaps.push(markGap(plan.units[index],
      baselineGapReason(plan.units[index],plan,cache)));
    if(shortfall.length===0)
      violations.push(exhausted?"coverage_matching_budget_exhausted":
        "simultaneous_qualified_coverage_unsatisfied");
  }
  return {
    valid:violations.length===0 && satisfied,
    completeCoverage:satisfied && violations.length===0,
    violations,gaps,
    cost:violations.length===0?costForWork(input,plan,work):null,
    matchingBudgetExhausted:exhausted,
  };
}
