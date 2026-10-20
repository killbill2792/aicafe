import { eligibleCandidates, isConfirmedAvailable, qualifies } from "./plannerCore";
import type { DemandUnit, ExpandedPlan } from "./plannerCore";
import type { PlannerInput, PlannerShift } from "./plannerTypes";

/**
 * An optional OWNER staffing floor, not a statement about California law.
 * The pre-existing reviewed profile is the only break-duration/deadline
 * evidence currently consumed by this planner. Without it, do not invent a
 * break or weaken normal headcount.
 */
export type BreakReservation = {
  employeeId: string; coverageId: string; locationId: string;
  start: number; end: number;
};

export const hasBreakCoveragePolicy = (input: PlannerInput) =>
  input.coverage.some(c => c.minHeadcountDuringBreak != null);

function reviewedDuration(input: PlannerInput): number | null {
  const profile = input.ruleProfile;
  if (!profile?.verified || profile.maxContinuousWorkMinutes == null ||
      profile.maxContinuousWorkMinutes <= 0) return null;
  const meal = profile.unpaidMealMinutes ?? 0;
  const rest = profile.paidRestMinutes ?? 0;
  const duration = meal > 0 ? meal : rest > 0 ? rest : null;
  return duration != null && duration % (input.slotMinutes ?? 30) === 0
    ? duration : null;
}

/**
 * Pick bounded, deterministic stagger candidates from fully available workers.
 * A reservation is NOT independently sufficient evidence of a real break:
 * the normal beam search still has to schedule work on both sides, and the
 * independent validator must see an actual PlannerShift.breaks entry.
 * Never reserve for immutable, already-started published assignments.
 */
export function proposeBreakReservations(input: PlannerInput, plan: ExpandedPlan,
  cache: Map<string, Array<{start:number;end:number}>>): BreakReservation[] {
  const duration = reviewedDuration(input);
  const limit = input.ruleProfile?.maxContinuousWorkMinutes;
  if (duration == null || limit == null) return [];
  const grid = input.slotMinutes ?? 30;
  const results: BreakReservation[] = [];
  for (const requirement of input.coverage) {
    if (requirement.minHeadcountDuringBreak == null ||
        requirement.priority !== "required" || requirement.minHeadcount <= 0) continue;
    const dates = new Map<string, DemandUnit[]>();
    for (const unit of plan.units) {
      if (unit.coverageId !== requirement.id || unit.seatIndex !== 0) continue;
      const date = unit.id.slice(requirement.id.length + 1).split(":")[0];
      const items = dates.get(date) ?? [];
      items.push(unit); dates.set(date, items);
    }
    for (const units of dates.values()) {
      units.sort((a,b)=>a.start-b.start);
      const first = units[0], last = units[units.length - 1];
      if (!first || !last) continue;
      const span = (last.end - first.start) / 60000;
      if (span <= limit || span < duration + 2 * grid) continue;
      const workers = eligibleCandidates(first, plan, cache)
        .filter(e => units.every(u => qualifies(e,u,plan.locations) &&
          isConfirmedAvailable({employeeId:e.id,locationId:u.locationId,
            start:u.start,end:u.end,pinned:false},e,plan.locations,cache)) &&
          !plan.pinned.some(w=>w.historical && w.employeeId===e.id &&
            w.start<last.end && w.end>first.start))
        .sort((a,b)=>a.id.localeCompare(b.id))
        .slice(0,requirement.minHeadcount);
      if (!workers.length) continue;
      const simultaneous = Math.max(1,
        requirement.minHeadcount - requirement.minHeadcountDuringBreak);
      const waves = Math.ceil(workers.length / simultaneous);
      const breakBlock = waves * duration;
      if (breakBlock + 2*grid > span) continue;
      const offset = Math.floor(((span-breakBlock)/2)/grid)*grid;
      for (let index=0;index<workers.length;index++) {
        const wave=Math.floor(index/simultaneous);
        const start=first.start+(offset+wave*duration)*60000;
        results.push({employeeId:workers[index].id,
          coverageId:requirement.id,locationId:requirement.locationId,
          start,end:start+duration*60000});
      }
    }
  }
  return results;
}

export function activeBreakReservations(unit: DemandUnit,
  breaks: readonly BreakReservation[]): BreakReservation[] {
  return breaks.filter(b=>b.coverageId===unit.coverageId &&
    b.start<=unit.start && b.end>=unit.end);
}

/** True only for demand seats legitimately waived while a break is reserved. */
export function demandSeatRequired(input:PlannerInput,unit:DemandUnit,
  breaks:readonly BreakReservation[]):boolean {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  if (!requirement || requirement.minHeadcountDuringBreak==null) return true;
  const breakCount=new Set(activeBreakReservations(unit,breaks)
    .map(b=>b.employeeId)).size;
  const floor=Math.max(requirement.minHeadcountDuringBreak,
    requirement.minHeadcount-breakCount);
  return (unit.seatIndex ?? 0) < floor;
}

/**
 * Independently identify duty-free, within-shift break windows for headcount
 * relaxation. An arbitrary gap or a short/unreviewed break earns NO credit.
 * The rest of the shift must exceed the profile's continuous-work threshold.
 */
export function recordedBreakCount(input:PlannerInput,plan:ExpandedPlan,
  shifts:readonly PlannerShift[],unit:DemandUnit):number {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  const profile=input.ruleProfile;
  if (requirement?.minHeadcountDuringBreak==null ||
      !profile?.verified || profile.maxContinuousWorkMinutes==null ||
      profile.maxContinuousWorkMinutes<=0) return 0;
  const employees=new Set<string>();
  for (const shift of shifts) {
    if (shift.locationId!==unit.locationId) continue;
    const person=plan.employees.find(e=>e.id===shift.employeeId);
    if (!person || !qualifies(person,unit,plan.locations)) continue;
    const shiftStart=Date.parse(shift.startAt),shiftEnd=Date.parse(shift.endAt);
    const workMinutes=(shiftEnd-shiftStart)/60000-
      shift.breaks.reduce((sum,b)=>sum+
        (Date.parse(b.endAt)-Date.parse(b.startAt))/60000,0);
    if (workMinutes<=profile.maxContinuousWorkMinutes) continue;
    for(const b of shift.breaks){
      const start=Date.parse(b.startAt),end=Date.parse(b.endAt);
      const expected=b.paid?profile.paidRestMinutes:profile.unpaidMealMinutes;
      if (expected==null || expected<=0 || (end-start)/60000!==expected ||
          !(shiftStart<start && end<shiftEnd) ||
          start>unit.start || end<unit.end) continue;
      employees.add(shift.employeeId);
    }
  }
  return employees.size;
}

export function recordedSeatRequired(input:PlannerInput,plan:ExpandedPlan,
  shifts:readonly PlannerShift[],unit:DemandUnit):boolean {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  if (!requirement || requirement.minHeadcountDuringBreak==null) return true;
  const floor=Math.max(requirement.minHeadcountDuringBreak,
    requirement.minHeadcount-recordedBreakCount(input,plan,shifts,unit));
  return (unit.seatIndex ?? 0) < floor;
}
