import { eligibleCandidates, isConfirmedAvailable, qualifies, workerWageRate } from "./plannerCore";
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
  /** Planned full work span, across adjacent owner coverage windows. */
  workStart?: number; workEnd?: number;
  /** Already recorded in an immutable published shift; never reschedule it. */
  historical?: boolean;
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
 * Work span is the maximal contiguous set of compatible coverage slices.
 * Matching business windows are allowed to use separate coverage rows (peak
 * staffing windows commonly do), without resetting employees' work clocks.
 */
type Span = { units: DemandUnit[]; locationId: string; qualificationCode: string|null;
  minHeadcount:number; breakFloor:number };
const samePolicy=(a:Span,b:Span)=>
  a.locationId===b.locationId &&
  a.qualificationCode===b.qualificationCode;

function coverageSpans(input:PlannerInput,plan:ExpandedPlan):Span[] {
  const slices=plan.units.filter(u=>u.seatIndex===0).flatMap(unit=>{
    const c=input.coverage.find(c=>c.id===unit.coverageId);
    return c?.priority==="required" && c.minHeadcountDuringBreak!=null && c.minHeadcount>0
      ? [{units:[unit],locationId:unit.locationId,
          qualificationCode:unit.qualificationCode,minHeadcount:c.minHeadcount,
          breakFloor:c.minHeadcountDuringBreak}] : [];
  }).sort((a,b)=>a.units[0].start-b.units[0].start ||
    a.locationId.localeCompare(b.locationId));
  // Partition before linking adjacent pieces: two locations or roles can
  // have interleaved slices and must not interrupt one another's work span.
  const groups=new Map<string,Span[]>();
  for(const item of slices){
    const key=JSON.stringify([item.locationId,item.qualificationCode]);
    const spans=groups.get(key)??[];
    const previous=spans[spans.length-1];
    if(previous && samePolicy(previous,item) &&
        previous.units[previous.units.length-1].end===item.units[0].start){
      previous.units.push(...item.units);
      previous.minHeadcount=Math.min(previous.minHeadcount,item.minHeadcount);
    } else spans.push(item);
    groups.set(key,spans);
  }
  return [...groups.values()].flat();
}

function priorityScore(employee:ExpandedPlan["employees"][number],
  objective:"cash"|"owner_time"|"balanced"):number {
  const rate=workerWageRate(employee) ?? 120_000;
  const owner=employee.isOwner?1:0;
  return objective==="owner_time"?owner*100_000_000+rate:
    objective==="cash"?rate+owner*100:rate+owner*10_000;
}

/** Use recorded, immutable breaks for frozen or in-progress re-planning. */
export function historicalBreakReservations(input:PlannerInput,
  plan:ExpandedPlan):BreakReservation[] {
  const profile=input.ruleProfile;
  if(!profile?.verified || profile.maxContinuousWorkMinutes==null) return [];
  const reservations:BreakReservation[]=[];
  for(const shift of input.startedPublishedShifts??[]){
    const workStart=Date.parse(shift.startAt),workEnd=Date.parse(shift.endAt);
    // Gross on-site time, not worked time net of this valid recorded break.
    if((workEnd-workStart)/60000<=profile.maxContinuousWorkMinutes)continue;
    for(const brk of shift.breaks){
      const start=Date.parse(brk.startAt),end=Date.parse(brk.endAt);
      const duration=brk.paid?profile.paidRestMinutes:profile.unpaidMealMinutes;
      if(duration==null || duration<=0 ||
          (end-start)/60000!==duration || start<=workStart || end>=workEnd)continue;
      for(const unit of plan.units){
        if(unit.seatIndex!==0 || unit.locationId!==shift.locationId ||
            unit.start<start || unit.end>end)continue;
        const req=input.coverage.find(c=>c.id===unit.coverageId);
        const worker=plan.employees.find(e=>e.id===shift.employeeId);
        if(!worker || req?.minHeadcountDuringBreak==null ||
            !qualifies(worker,unit,plan.locations))continue;
        if(!reservations.some(b=>b.employeeId===shift.employeeId &&
            b.coverageId===unit.coverageId && b.start===start))
          reservations.push({employeeId:shift.employeeId,coverageId:unit.coverageId,
            locationId:shift.locationId,start,end,workStart,workEnd,historical:true});
      }
    }
  }
  return reservations;
}

/**
 * Reserve staggered breaks on the full contiguous demand span. Choose the
 * actual candidate workforce for EACH objective and force it into the solver
 * search on both sides of those breaks; a reserved worker is not an invisible
 * placeholder that can grant an uncovered seat. Unusable reservations cannot
 * make a scenario valid: the independent validator checks actual shift breaks.
 */
export function proposeBreakReservations(input: PlannerInput, plan: ExpandedPlan,
  cache: Map<string, Array<{start:number;end:number}>>,
  objective:"cash"|"owner_time"|"balanced"="cash"): BreakReservation[] {
  const results=historicalBreakReservations(input,plan);
  const duration=reviewedDuration(input);
  const limit=input.ruleProfile?.maxContinuousWorkMinutes;
  if(duration==null || limit==null)return results;
  const grid=input.slotMinutes??30;
  type Candidate = {span:Span;first:DemandUnit;last:DemandUnit;
    people:ExpandedPlan["employees"];count:number;simultaneous:number};
  const candidates:Candidate[]=[];
  for(const span of coverageSpans(input,plan)){
    const first=span.units[0],last=span.units[span.units.length-1];
    const total=(last.end-first.start)/60000;
    if(total<=limit || total<duration+2*grid)continue;
    const people=eligibleCandidates(first,plan,cache)
      .filter(e=>span.units.every(u=>qualifies(e,u,plan.locations) &&
        isConfirmedAvailable({employeeId:e.id,locationId:u.locationId,
          start:u.start,end:u.end,pinned:false},e,plan.locations,cache)) &&
        !plan.pinned.some(w=>w.historical && w.employeeId===e.id &&
          w.start<last.end && w.end>first.start))
      .sort((a,b)=>priorityScore(a,objective)-priorityScore(b,objective) ||
        a.id.localeCompare(b.id));
    const count=Math.min(span.minHeadcount,people.length);
    if(count===0)continue;
    // Peak windows may change normal headcount AND break floor. A reservation
    // must obey the tightest permitted headcount drop during the work span.
    const slack=Math.min(...span.units.map(u=>{
      const c=input.coverage.find(c=>c.id===u.coverageId)!;
      return c.minHeadcount-(c.minHeadcountDuringBreak??c.minHeadcount);
    }));
    const simultaneous=Math.max(1,slack);
    if(Math.ceil(count/simultaneous)*duration+2*grid>total)continue;
    candidates.push({span,first,last,people,count,simultaneous});
  }
  // Select the break-taking crew jointly for concurrent locations and roles.
  // Each candidate is scored for this objective, but no person may be committed
  // to overlapping spans; bounded backtracking avoids a greedy dead end.
  candidates.sort((a,b)=>(a.people.length-a.count)-(b.people.length-b.count) ||
    a.first.start-b.first.start || a.span.locationId.localeCompare(b.span.locationId));
  const roster=new Map<Candidate,ExpandedPlan["employees"]>();
  const slots=candidates.flatMap(entry=>Array.from({length:entry.count},()=>entry));
  let attempts=0;
  function select(index:number):boolean {
    if(index===slots.length)return true;
    if(attempts>=12_000)return false;
    const entry=slots[index],chosen=roster.get(entry)??[];
    for(const person of entry.people){
      if(++attempts>12_000)return false;
      if(chosen.some(p=>p.id===person.id))continue;
      if([...roster].some(([other,assigned])=>other!==entry &&
        entry.first.start<other.last.end && other.first.start<entry.last.end &&
        assigned.some(p=>p.id===person.id)))continue;
      chosen.push(person);roster.set(entry,chosen);
      if(select(index+1))return true;
      chosen.pop();
    }
    return false;
  }
  if(!select(0))return results; // No break credit without a staffed roster.
  for(const entry of candidates){
    const workers=roster.get(entry)??[];
    const total=(entry.last.end-entry.first.start)/60000;
    const waves=Math.ceil(workers.length/entry.simultaneous);
    const breakBlock=waves*duration;
    const offset=Math.floor(((total-breakBlock)/2)/grid)*grid;
    const coverageIds=new Set(entry.span.units.map(u=>u.coverageId));
    for(let i=0;i<workers.length;i++){
      const start=entry.first.start+
        (offset+Math.floor(i/entry.simultaneous)*duration)*60000;
      const end=start+duration*60000;
      for(const coverageId of coverageIds)
        results.push({employeeId:workers[i].id,coverageId,
          locationId:entry.span.locationId,start,end,
          workStart:entry.first.start,workEnd:entry.last.end});
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
 * The gross shift span must exceed the reviewed continuous-work threshold.
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
    // A valid break may reduce net work exactly to the threshold.
    if ((shiftEnd-shiftStart)/60000<=profile.maxContinuousWorkMinutes) continue;
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
