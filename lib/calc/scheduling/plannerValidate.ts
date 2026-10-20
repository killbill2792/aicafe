import { expandPlannerInput, isConfirmedAvailable, qualifies, baselineGapReason,
  type DemandUnit, type WorkUnit } from "./plannerCore";
import { localParts, parseUtcInstant, utcIso } from "./plannerClock";
import { costForWork, hardValid } from "./plannerRules";
import { recordedBreakCount, recordedSeatRequired } from "./plannerBreakCoverage";
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
  const freezeKey=(s:PlannerShift)=>JSON.stringify({
    employeeId:s.employeeId,locationId:s.locationId,startAt:s.startAt,
    endAt:s.endAt,paidMinutes:s.paidMinutes,breaks:s.breaks,pinned:s.pinned,
  });
  const requiredFrozen=new Map<string,number>();
  for(const s of input.startedPublishedShifts??[]){
    const key=freezeKey(s);
    requiredFrozen.set(key,(requiredFrozen.get(key)??0)+1);
  }
  const cutoff=input.replanAsOf==null?null:parseUtcInstant(input.replanAsOf);
  const declaredPaidRest=new Set<string>();
  const interval=input.slotMinutes??30;
  if(proposal.length>2000)throw new Error("invalid_planner_input:too_many_shifts");
  for(const shift of proposal){
    try {
      const frozenKey=freezeKey(shift);
      const remaining=requiredFrozen.get(frozenKey)??0;
      const historical=remaining>0;
      if(historical)requiredFrozen.set(frozenKey,remaining-1);
      else if(cutoff!=null && parseUtcInstant(shift.startAt)<=cutoff)
        throw new Error("new_retroactive_shift");
      if(!plan.employees.some(e=>e.id===shift.employeeId) ||
        !plan.locations.has(shift.locationId))
        throw new Error("unknown_employee_or_location");
      const start=parseUtcInstant(shift.startAt);
      const end=parseUtcInstant(shift.endAt);
      if(end<=start || (end-start)% (interval*60000)!==0 || end-start>24*3_600_000)
        throw new Error("invalid_shift_interval");
      const zone=plan.locations.get(shift.locationId)!.timezone;
      const startDate=localParts(start,zone).date;
      // An overnight shift may finish after the horizon, but its first
      // calendar date must belong to the seven-day input snapshot.
      if(startDate<input.horizonStart || startDate>plan.horizonEnd)
        throw new Error("shift_outside_seven_day_horizon");
      const breaks=shift.breaks.map(b=>({
        start:parseUtcInstant(b.startAt),end:parseUtcInstant(b.endAt),paid:b.paid,
      })).sort((a,b)=>a.start-b.start);
      let last=start,unpaid=0;
      for(const brk of breaks){
        if(brk.start<last || brk.end<=brk.start ||
          brk.end>end || (brk.end-brk.start)%(interval*60000)!==0 ||
          (brk.start-start)%(interval*60000)!==0 ||
          (brk.end-start)%(interval*60000)!==0)
          throw new Error("invalid_unpaid_break");
        last=brk.end;
        const breakMinutes=(brk.end-brk.start)/60000;
        if(brk.paid){
          // Paid rest remains compensable, but supplies ZERO work coverage.
          const rule=input.ruleProfile;
          if(!historical && (!rule?.verified || rule.paidRestMinutes==null ||
            breakMinutes!==rule.paidRestMinutes))
            throw new Error("unverified_paid_rest_break");
          declaredPaidRest.add([shift.employeeId,shift.locationId,
            brk.start,brk.end].join("|"));
        } else {
          unpaid+=breakMinutes;
          if(!historical && input.ruleProfile?.unpaidMealMinutes!=null &&
            breakMinutes<input.ruleProfile.unpaidMealMinutes)
            throw new Error("meal_shorter_than_configured_minimum");
        }
      }
      if(!Number.isSafeInteger(shift.paidMinutes) ||
        shift.paidMinutes!==(end-start)/60000-unpaid)
        throw new Error("paid_minutes_mismatch");
      for(let t=start;t<end;t+=interval*60000){
        if(breaks.some(b=>b.start<t+interval*60000 && b.end>t))continue;
        work.push({employeeId:shift.employeeId,locationId:shift.locationId,
          start:t,end:t+interval*60000,pinned:historical,historical});
      }
    }catch(error){
      violations.push(error instanceof Error?error.message:"invalid_shift");
    }
  }
  if([...requiredFrozen.values()].some(count=>count>0))
    violations.push("pinned_commitment_removed");
  // A gap exactly matching a paid rest duration cannot silently become
  // compensable just because two separately authored shifts are adjacent.
  // Paid rest must appear explicitly in the proposed shift's break record.
  const paidRest=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
  if(paidRest!=null && paidRest>0){
    const perWorker=new Map<string,WorkUnit[]>();
    for(const piece of work){
      const rows=perWorker.get(piece.employeeId)??[];
      rows.push(piece);perWorker.set(piece.employeeId,rows);
    }
    for(const [employeeId,rows] of perWorker){
      rows.sort((a,b)=>a.start-b.start||a.end-b.end);
      for(let i=1;i<rows.length;i++){
        const before=rows[i-1],after=rows[i];
        if(before.locationId===after.locationId &&
          (after.start-before.end)/60000===paidRest &&
          !declaredPaidRest.has([employeeId,after.locationId,
            before.end,after.start].join("|")))
          violations.push("unrecorded_paid_rest_break:"+employeeId+":"+utcIso(before.end));
      }
    }
  }
  const cache=new Map<string,Array<{start:number;end:number}>>();
  for(const piece of work){
    const employee=plan.employees.find(e=>e.id===piece.employeeId);
    if(employee && !piece.historical &&
       !isConfirmedAvailable(piece,employee,plan.locations,cache)){
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
  const historicalWork=work.filter(w=>w.historical);
  const candidates=plan.units.map(unit=>
    plan.employees.filter(e=>
      (cutoff!=null && unit.start<cutoff
        ? coveredBy(historicalWork,unit,e.id)
        : qualifies(e,unit,plan.locations)) &&
      coveredBy(work,unit,e.id)).map(e=>e.id).sort());
  // Advisory coverage is a soft preference, not a hard publish gate.
  const indices=plan.units.map((_,i)=>i)
    .filter(i=>plan.units[i].priority==="required" &&
      recordedSeatRequired(input,plan,proposal,plan.units[i])).sort((a,b)=>
    candidates[a].length-candidates[b].length ||
    plan.units[a].start-plan.units[b].start ||
    plan.units[a].id.localeCompare(plan.units[b].id));
  const chosen=new Map<number,string>();
  let nodes=0,exhausted=false;
  let deepestUnmatched=-1;
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
    deepestUnmatched=Math.max(deepestUnmatched,position);
    return false;
  }
  const satisfied=match(0);
  if(!satisfied){
    const shortfall=indices.filter(i=>candidates[i].length===0);
    for(const index of shortfall){
      const unit=plan.units[index];
      gaps.push(markGap(unit,recordedBreakCount(input,plan,proposal,unit)>0
        ?"break_coverage_unsatisfiable":baselineGapReason(unit,plan,cache)));
    }
    if(shortfall.length===0){
      if(!exhausted && deepestUnmatched>=0 && deepestUnmatched<indices.length)
        {
          const unit=plan.units[indices[deepestUnmatched]];
          gaps.push(markGap(unit,recordedBreakCount(input,plan,proposal,unit)>0
            ?"break_coverage_unsatisfiable":"capacity_or_overlap"));
        }
      violations.push(exhausted?"coverage_matching_budget_exhausted":
        gaps.some(g=>g.reason==="break_coverage_unsatisfiable")
        ?"break_coverage_unsatisfiable":"simultaneous_qualified_coverage_unsatisfied");
    }
  }
  // A staffing handoff requires a verified overlap of the old and new
  // team, not merely a continuous headcount at adjacent slot boundaries.
  // If enough qualified workers remain continuously assigned, no handoff
  // occurs. Otherwise the incoming coverage cohort must already have worked
  // together for the owner-configured minimum overlap interval.
  for(const requirement of input.coverage){
    if(requirement.priority!=="required" ||
      (requirement.minOverlapMinutes??0)===0 || requirement.minHeadcount===0)
      continue;
    const byStart=new Map<number,number>();
    for(let i=0;i<plan.units.length;i++){
      const unit=plan.units[i];
      if(unit.coverageId===requirement.id && !byStart.has(unit.start))
        byStart.set(unit.start,i);
    }
    const ordered=[...byStart.values()].sort((a,b)=>plan.units[a].start-plan.units[b].start);
    for(let i=1;i<ordered.length;i++){
      const previous=plan.units[ordered[i-1]],current=plan.units[ordered[i]];
      if(previous.end!==current.start ||
        (cutoff!=null && current.start<cutoff))continue; // no retrospective handoffs
      const before=new Set(candidates[ordered[i-1]]);
      const after=new Set(candidates[ordered[i]]);
      if(before.size===after.size && [...before].every(id=>after.has(id)))
        continue; // same qualified team; no worker handoff
      if(requirement.minHeadcountDuringBreak!=null){
        const changed=[...new Set([...before,...after])].filter(id=>
          before.has(id)!==after.has(id));
        // A worker entering/exiting a duty-free break inside the same
        // recorded shift is NOT a replacement hire/shift handoff.
        const breakBoundary=(id:string)=>proposal.some(s=>
          s.employeeId===id && s.locationId===requirement.locationId &&
          Date.parse(s.startAt)<current.start && Date.parse(s.endAt)>current.start &&
          s.breaks.some(b=>Date.parse(b.startAt)===current.start ||
            Date.parse(b.endAt)===current.start));
        if(changed.length>0 && changed.every(breakBoundary))continue;
      }
      const overlapStart=current.start-requirement.minOverlapMinutes!*60_000;
      const qualifiedDuringOverlap=candidates[ordered[i]].filter(id=>
        coveredBy(work,{...current,start:overlapStart,end:current.start},id));
      const breakCount=recordedBreakCount(input,plan,proposal,current);
      const target=requirement.minHeadcountDuringBreak==null?requirement.minHeadcount:
        Math.max(requirement.minHeadcountDuringBreak,requirement.minHeadcount-breakCount);
      if(qualifiedDuringOverlap.length>=target)continue;
      const missing=target-qualifiedDuringOverlap.length;
      gaps.push({coverageId:requirement.id,locationId:requirement.locationId,
        startAt:utcIso(overlapStart),endAt:utcIso(current.start),
        qualificationCode:requirement.qualificationCode??null,
        missingHeadcount:missing,reason:"handoff_overlap_missing"});
      violations.push("handoff_overlap_missing:"+requirement.id+":"+utcIso(current.start));
    }
  }
  return {
    valid:violations.length===0 && satisfied,
    completeCoverage:satisfied && violations.length===0,
    violations,gaps,
    cost:violations.length===0?costForWork(input,plan,work):null,
    matchingBudgetExhausted:exhausted,
  };
}
