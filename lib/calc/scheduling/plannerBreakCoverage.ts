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
  minHeadcount:number; breakFloor:number; tierCap?:number };
const samePolicy=(a:Span,b:Span)=>
  a.locationId===b.locationId;

function coverageSpans(input:PlannerInput,plan:ExpandedPlan):Span[] {
  const slices=plan.units.filter(u=>u.seatIndex===0).flatMap(unit=>{
    const c=input.coverage.find(c=>c.id===unit.coverageId);
    // An opted-out row still contributes to continuous work and must be
    // staffed in full. It cannot, however, authorize any break waiver.
    return c?.priority==="required" && c.minHeadcount>0
      ? [{units:[unit],locationId:unit.locationId,
          qualificationCode:unit.qualificationCode,minHeadcount:c.minHeadcount,
          breakFloor:c.minHeadcountDuringBreak ?? c.minHeadcount}] : [];
  }).sort((a,b)=>a.units[0].start-b.units[0].start ||
    a.locationId.localeCompare(b.locationId) ||
    String(a.qualificationCode).localeCompare(String(b.qualificationCode)));
  // Partition before linking adjacent pieces: two locations or roles can
  // have interleaved slices and must not interrupt one another's work span.
  const groups=new Map<string,Span[]>();
  for(const item of slices){
    const key=JSON.stringify([item.locationId]);
    const spans=groups.get(key)??[];
    const touching=spans.filter(existing=>samePolicy(existing,item) &&
      existing.units[existing.units.length-1].end===item.units[0].start);
    // Continue an existing role first. Change duties across an adjacent row
    // only when there is ONE unambiguous continuous cohort, never blend
    // simultaneous qualification requirements into the same seat tier.
    const previous=touching.find(existing=>
      existing.units[existing.units.length-1].qualificationCode===
      item.units[0].qualificationCode) ||
      (touching.length===1?touching[0]:undefined);
    // A general multi-seat cohort can split into multiple specialized single
    // seat paths. Keep a still-open copy of the predecessor for the next
    // simultaneous role instead of consuming its whole work history with
    // the first role encountered in stable sort order.
    if(previous && touching.length===1 && previous.tierCap==null &&
        previous.units[previous.units.length-1].qualificationCode!==
        item.units[0].qualificationCode &&
        previous.minHeadcount>item.minHeadcount && item.minHeadcount===1){
      spans.push({...previous,units:previous.units.slice(),tierCap:1});
      previous.tierCap=1;
    }
    // When separate single-seat qualified cohorts converge into one
    // general multi-seat row, preserve EACH possible worker's work clock.
    // The shared row contributes only ONE tier per existing path; otherwise
    // appending a 2-seat general demand to both paths double-counts demand.
    const converged=touching.length>1 &&
      item.minHeadcount>=touching.length &&
      touching.every(existing=>existing.tierCap===1 ||
        existing.minHeadcount===1);
    if(converged){
      for(const existing of touching){
        existing.units.push(...item.units);
        existing.minHeadcount=Math.min(existing.minHeadcount,item.minHeadcount);
        existing.tierCap=1;
      }
    }else if(previous){
      previous.units.push(...item.units);
      previous.minHeadcount=Math.min(previous.minHeadcount,item.minHeadcount);
    }else spans.push(item);
    groups.set(key,spans);
  }
  // Preserve byte-identical opt-out behavior: do not plan break reservations
  // for an entirely unset-policy chain.
  return [...groups.values()].flat().filter(span=>span.units.some(u=>
    input.coverage.find(c=>c.id===u.coverageId)?.minHeadcountDuringBreak!=null));
}

/** A headcount increase adds new worker tiers without resetting existing
 * workers' continuous on-site spans. Model a potential break for each tier
 * that itself runs beyond the reviewed limit, including peak-only workers.
 */
function workerTierSpans(input:PlannerInput,plan:ExpandedPlan):Span[] {
  const tiers:Span[]=[];
  for(const group of coverageSpans(input,plan)){
    const max=Math.min(group.tierCap??Infinity,Math.max(...group.units.map(u=>
      input.coverage.find(c=>c.id===u.coverageId)!.minHeadcount)));
    for(let seat=0;seat<max;seat++){
      let segment:DemandUnit[]=[];
      const finish=()=>{
        if(segment.length)tiers.push({...group,units:segment,
          minHeadcount:1});
        segment=[];
      };
      for(const unit of group.units){
        const c=input.coverage.find(c=>c.id===unit.coverageId)!;
        if(c.minHeadcount<=seat){finish();continue;}
        if(segment.length && segment[segment.length-1].end!==unit.start)finish();
        segment.push(unit);
      }
      finish();
    }
  }
  return tiers;
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
  const gridMs=grid*60000,durationMs=duration*60000;
  type Candidate = {span:Span;first:DemandUnit;last:DemandUnit;
    people:ExpandedPlan["employees"]};
  const candidates:Candidate[]=[];
  for(const span of workerTierSpans(input,plan)){
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
    if(people.length)candidates.push({span,first,last,people});
  }
  // Jointly bind one distinct worker to each continuous seat tier.
  // Workers cannot occupy concurrent tiers in different locations or roles.
  candidates.sort((a,b)=>a.people.length-b.people.length ||
    a.first.start-b.first.start || a.span.locationId.localeCompare(b.span.locationId));
  const roster=new Map<Candidate,ExpandedPlan["employees"][number]>();
  let bestRoster=new Map<Candidate,ExpandedPlan["employees"][number]>();
  let attempts=0;
  function select(index:number):void {
    if(attempts>=12_000 ||
        roster.size+candidates.length-index<=bestRoster.size)return;
    if(index===candidates.length){
      bestRoster=new Map(roster);
      return;
    }
    const entry=candidates[index];
    for(const person of entry.people){
      if(++attempts>12_000)return;
      if([...roster].some(([other,worker])=>worker.id===person.id &&
        entry.first.start<other.last.end && other.first.start<entry.last.end))
        continue;
      roster.set(entry,person);
      select(index+1);
      roster.delete(entry);
    }
    // This abstract long seat tier may be staffed by shorter B -> C shifts
    // and requires no individual worker break. Skip only THAT reservation,
    // rather than rejecting all full-span A reservations in the location.
    select(index+1);
  }
  select(0);

  // A single seat tier can be handed off between employees. Some of those
  // workers nevertheless exceed their OWN continuous-work limit (e.g. B works
  // 09:00-13:00 before C takes over at 13:00). Reserve their actual available
  // subsequence, without forcing them across the handoff boundary.
  for(const group of coverageSpans(input,plan)){
    const fromGroup=(entry:Candidate)=>group.units.includes(entry.span.units[0]);
    const selected=[...bestRoster].filter(([entry])=>fromGroup(entry))
      .map(([,person])=>person.id);
    const partial:Candidate[]=[];
    for(const person of plan.employees){
      if(selected.includes(person.id))continue;
      let run:DemandUnit[]=[];
      const finish=()=>{
        if(run.length){
          const first=run[0],last=run[run.length-1];
          const total=(last.end-first.start)/60000;
          // Full-span crew members already compete in the normal seat-tier
          // search. This fallback is ONLY for genuinely partial handoff staff.
          const groupFirst=group.units[0],groupLast=group.units[group.units.length-1];
          if((first.start>groupFirst.start || last.end<groupLast.end) &&
              total>limit && total>=duration+2*grid)
            partial.push({span:{...group,units:run},first,last,people:[person]});
        }
        run=[];
      };
      for(const unit of group.units){
        const available=qualifies(person,unit,plan.locations) &&
          isConfirmedAvailable({employeeId:person.id,locationId:unit.locationId,
            start:unit.start,end:unit.end,pinned:false},person,plan.locations,cache) &&
          !plan.pinned.some(w=>w.historical && w.employeeId===person.id &&
            w.start<unit.end && w.end>unit.start);
        if(!available){finish();continue;}
        if(run.length && run[run.length-1].end!==unit.start)finish();
        run.push(unit);
      }
      finish();
    }
    partial.sort((a,b)=>(b.last.end-b.first.start)-(a.last.end-a.first.start) ||
      priorityScore(a.people[0],objective)-priorityScore(b.people[0],objective) ||
      a.people[0].id.localeCompare(b.people[0].id));
    for(const entry of partial){
      const person=entry.people[0];
      if([...bestRoster].some(([other,worker])=>
        worker.id===person.id && entry.first.start<other.last.end &&
        other.first.start<entry.last.end))continue;
      // Bound SIMULTANEOUS participants in each requirement, not the total
      // number of sequential B -> C -> D workers in one abstract seat tier.
      if(entry.span.units.some(u=>{
        const need=input.coverage.find(c=>c.id===u.coverageId)!.minHeadcount;
        return [...bestRoster.keys()].filter(other=>fromGroup(other) &&
          other.first.start<u.end && other.last.end>u.start).length>=need;
      }))continue;
      bestRoster.set(entry,person);
    }
  }
  if(bestRoster.size===0)return results;

  type Placement={entry:Candidate;employeeId:string;start:number;end:number;
    coverageIds:string[]};
  const placements=[...bestRoster.keys()].map(entry=>{
    const employeeId=bestRoster.get(entry)!.id;
    const coverageIds=[...new Set(entry.span.units.map(u=>u.coverageId))];
    const choices:Placement[]=[];
    for(let start=entry.first.start+gridMs;
        start+durationMs+gridMs<=entry.last.end;start+=gridMs){
      const end=start+durationMs;
      if((start-entry.first.start)/60000>limit ||
          (entry.last.end-end)/60000>limit)continue;
      if(!entry.span.units.some(u=>u.start>=start && u.end<=end))continue;
      choices.push({entry,employeeId,start,end,coverageIds});
    }
    // Try near-middle breaks first, but search alternative legal windows when
    // a zero-slack window makes the centered position impossible.
    const center=(entry.first.start+entry.last.end)/2;
    choices.sort((a,b)=>Math.abs((a.start+a.end)/2-center)-
      Math.abs((b.start+b.end)/2-center) || a.start-b.start);
    return {entry,choices};
  }).filter(x=>x.choices.length>0);
  placements.sort((a,b)=>a.choices.length-b.choices.length);
  const scheduled=results.slice();
  const insert=(p:Placement)=>p.coverageIds.map(coverageId=>({
    employeeId:p.employeeId,coverageId,locationId:p.entry.span.locationId,
    start:p.start,end:p.end,workStart:p.entry.first.start,workEnd:p.entry.last.end,
  }));
  let positionAttempts=0;
  function fits(p:Placement):boolean {
    const preview=[...scheduled,...insert(p)];
    for(const unit of p.entry.span.units){
      if(unit.start<p.start || unit.end>p.end)continue;
      const requirement=input.coverage.find(c=>c.id===unit.coverageId)!;
      const floor=requirement.minHeadcountDuringBreak;
      if(floor==null)return false;
      // Breaks remove a PERSON from the slot, not permanently one of the
      // original demand seats. A third qualified relief worker may preserve
      // even a full (= normal) owner floor while A or B takes a real break.
      const eligible=eligibleCandidates(unit,plan,cache);
      const ids=new Set(eligible.map(e=>e.id));
      const breaking=new Set(preview.filter(b=>
        b.locationId===unit.locationId && b.start<=unit.start &&
        b.end>=unit.end && ids.has(b.employeeId)).map(b=>b.employeeId));
      const normalSlack=requirement.minHeadcount-floor;
      // Prefer explicit owner-permitted staggering when a lower break floor
      // exists. Use extra relief only when the floor otherwise allows ZERO
      // absences (floor === normal headcount); concurrent breaks with spare
      // workers can otherwise force unnecessary continuous-work violations.
      const permitted=normalSlack>0?normalSlack:
        Math.max(0,eligible.length-requirement.minHeadcount);
      if(breaking.size>permitted ||
          eligible.filter(e=>!breaking.has(e.id)).length<floor)return false;

      // Relief must be matched ONCE across every concurrent location/role
      // requirement. One dual-qualified replacement cannot satisfy both a
      // cashier and a barista while both take their breaks simultaneously.
      const globalBreaking=new Set(preview.filter(b=>
        b.start<=unit.start && b.end>=unit.end).map(b=>b.employeeId));
      const needed=plan.units.filter(other=>
        other.priority==="required" && other.start<=unit.start &&
        other.end>=unit.end &&
        demandSeatRequired(input,plan,other,preview));
      const options=needed.map(other=>eligibleCandidates(other,plan,cache)
        .map(e=>e.id).filter(id=>!globalBreaking.has(id)));
      const assigned=new Map<string,number>();
      function match(index:number,seen:Set<string>):boolean {
        for(const id of options[index]){
          if(seen.has(id))continue;
          seen.add(id);
          const prior=assigned.get(id);
          if(prior==null || match(prior,seen)){
            assigned.set(id,index);return true;
          }
        }
        return false;
      }
      if(needed.some((_,i)=>!match(i,new Set())))return false;
    }
    return true;
  }
  function place(index:number):boolean {
    if(index===placements.length)return true;
    if(positionAttempts>=12_000)return false;
    const item=placements[index];
    for(const p of item.choices){
      if(++positionAttempts>12_000)return false;
      if(!fits(p))continue;
      const rows=insert(p);scheduled.push(...rows);
      if(place(index+1))return true;
      scheduled.splice(scheduled.length-rows.length,rows.length);
    }
    return false;
  }
  if(place(0))return scheduled;
  // No feasible floor-preserving placement was found. Still put a real
  // candidate break on the roster to expose the exact unsatisfiable floor
  // instead of silently skipping the worker's reviewed break.
  for(const item of placements){
    const chosen=item.choices[0];
    if(chosen)results.push(...insert(chosen));
  }
  return results;
}

export function activeBreakReservations(unit: DemandUnit,
  breaks: readonly BreakReservation[]): BreakReservation[] {
  return breaks.filter(b=>b.coverageId===unit.coverageId &&
    b.start<=unit.start && b.end>=unit.end);
}

/**
 * Allocate each break-taker to at most ONE simultaneous requirement.
 * This is the same distinct-person rule that work-seat matching enforces.
 * A single edited or published break must never erase two different roles'
 * required seats. A bounded augmenting-path matching preserves qualified
 * specialist capacity rather than greedily giving the first row every break.
 */
type BreakCreditCache = Map<string,Map<string,number>>;
function allocatedBreakCredits(input:PlannerInput,plan:ExpandedPlan,
  slot:DemandUnit,eligible:(row:DemandUnit)=>string[],
  cache?:BreakCreditCache):Map<string,number> {
  const key=`${slot.start}:${slot.end}`;
  const cached=cache?.get(key);
  if(cached)return cached;
  const rows=new Map<string,DemandUnit>();
  for(const row of plan.units) {
    if(row.seatIndex!==0 || row.priority!=="required" ||
        row.start>slot.start || row.end<slot.end)continue;
    const requirement=input.coverage.find(c=>c.id===row.coverageId);
    if(requirement?.minHeadcountDuringBreak==null ||
        requirement.minHeadcount<=requirement.minHeadcountDuringBreak)continue;
    rows.set(row.coverageId,row);
  }
  type Claim={coverageId:string; people:string[]};
  const claims:Claim[]=[];
  for(const row of [...rows.values()].sort((a,b)=>a.id.localeCompare(b.id))) {
    const requirement=input.coverage.find(c=>c.id===row.coverageId)!;
    const people=[...new Set(eligible(row))].sort();
    const capacity=Math.min(people.length,
      requirement.minHeadcount-requirement.minHeadcountDuringBreak!);
    for(let i=0;i<capacity;i++)claims.push({coverageId:row.coverageId,people});
  }
  // Constrained roles with fewer eligible break takers get first attempt.
  claims.sort((a,b)=>a.people.length-b.people.length ||
    a.coverageId.localeCompare(b.coverageId));
  const claimedBy=new Map<string,number>();
  function assign(index:number,seen:Set<string>):boolean {
    for(const employeeId of claims[index].people) {
      if(seen.has(employeeId))continue;
      seen.add(employeeId);
      const prior=claimedBy.get(employeeId);
      if(prior==null || assign(prior,seen)){
        claimedBy.set(employeeId,index);
        return true;
      }
    }
    return false;
  }
  for(let i=0;i<claims.length;i++)assign(i,new Set());
  const counts=new Map<string,number>();
  for(const index of claimedBy.values()){
    const id=claims[index].coverageId;
    counts.set(id,(counts.get(id)??0)+1);
  }
  cache?.set(key,counts);
  return counts;
}

/** True only for seats waived by distinct, actively reserved workers. */
export function demandSeatRequired(input:PlannerInput,plan:ExpandedPlan,
  unit:DemandUnit,breaks:readonly BreakReservation[],
  cache?:BreakCreditCache):boolean {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  if(!requirement || requirement.minHeadcountDuringBreak==null)return true;
  const credits=allocatedBreakCredits(input,plan,unit,
    row=>breaks.filter(b=>b.coverageId===row.coverageId &&
      b.locationId===row.locationId && b.start<=unit.start &&
      b.end>=unit.end).map(b=>b.employeeId),cache);
  return (unit.seatIndex??0)<requirement.minHeadcount-
    (credits.get(unit.coverageId)??0);
}

/**
 * Independently credit actual, within-shift, qualified, reviewed breaks.
 * The gross shift span, rather than worked time net of the break, determines
 * whether the configured continuous-work threshold would be exceeded.
 */
/** For diagnostics, detect a reviewed break even when the owner floor
 * permits ZERO waiver seats. Credit and diagnostics must remain distinct.
 */
export function reviewedRecordedBreakWorkers(input:PlannerInput,plan:ExpandedPlan,
  shifts:readonly PlannerShift[],unit:DemandUnit):string[] {
  const profile=input.ruleProfile;
  if(!profile?.verified || profile.maxContinuousWorkMinutes==null ||
      profile.maxContinuousWorkMinutes<=0)return [];
  const people:string[]=[];
  for(const shift of shifts){
    if(shift.locationId!==unit.locationId)continue;
    const person=plan.employees.find(e=>e.id===shift.employeeId);
    if(!person || !qualifies(person,unit,plan.locations))continue;
    const shiftStart=Date.parse(shift.startAt),shiftEnd=Date.parse(shift.endAt);
    if((shiftEnd-shiftStart)/60000<=profile.maxContinuousWorkMinutes)continue;
    for(const b of shift.breaks){
      const start=Date.parse(b.startAt),end=Date.parse(b.endAt);
      const expected=b.paid?profile.paidRestMinutes:profile.unpaidMealMinutes;
      if(expected==null || expected<=0 || (end-start)/60000!==expected ||
          !(shiftStart<start && end<shiftEnd) ||
          start>unit.start || end<unit.end)continue;
      // An edited draft cannot claim a duty-free break while scheduling
      // this very employee to work in another concurrent shift. Verify
      // every proposal shift for actual duty during the credited slot.
      const worksElsewhere=shifts.some(other=>{
        if(other===shift || other.employeeId!==shift.employeeId)return false;
        const start=Math.max(unit.start,Date.parse(other.startAt));
        const end=Math.min(unit.end,Date.parse(other.endAt));
        if(start>=end)return false;
        return !other.breaks.some(another=>
          Date.parse(another.startAt)<=start &&
          Date.parse(another.endAt)>=end);
      });
      if(worksElsewhere)continue;
      people.push(shift.employeeId);
      break;
    }
  }
  return people;
}

export function recordedBreakCount(input:PlannerInput,plan:ExpandedPlan,
  shifts:readonly PlannerShift[],unit:DemandUnit,
  cache?:BreakCreditCache):number {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  if(requirement?.minHeadcountDuringBreak==null)return 0;
  return allocatedBreakCredits(input,plan,unit,
    row=>reviewedRecordedBreakWorkers(input,plan,shifts,row),cache)
    .get(unit.coverageId)??0;
}

export function recordedSeatRequired(input:PlannerInput,plan:ExpandedPlan,
  shifts:readonly PlannerShift[],unit:DemandUnit,
  cache?:BreakCreditCache):boolean {
  const requirement=input.coverage.find(c=>c.id===unit.coverageId);
  if(!requirement || requirement.minHeadcountDuringBreak==null)return true;
  return (unit.seatIndex??0)<requirement.minHeadcount-
    recordedBreakCount(input,plan,shifts,unit,cache);
}
