import { localParts, utcIso } from "./plannerClock";
import { baselineGapReason, eligibleCandidates, expandPlannerInput,
  isConfirmedAvailable, qualifies, workerWageRate,
  type WorkUnit, type DemandUnit, type ExpandedPlan } from "./plannerCore";
import { costForWork, hardValid, shiftsForWork } from "./plannerRules";
import { validateOliviaAssignments } from "./plannerValidate";
import { activeBreakReservations, demandSeatRequired, hasBreakCoveragePolicy,
  proposeBreakReservations, type BreakReservation } from "./plannerBreakCoverage";
import type {
  PlannerInput, PlannerResult, PlannerScenario, PlannerComparison, PlannerGap,
} from "./plannerTypes";

type Objective = PlannerScenario["objective"];
function hasReviewedLegalInputs(input:PlannerInput,plan:ExpandedPlan):boolean {
  const profile=input.ruleProfile;
  return Boolean(profile?.verified && profile.overtime?.verified &&
    profile.source?.trim() && plan.locations.size>0 &&
    [...plan.locations.keys()].every(id=>{
      const jurisdiction=profile?.jurisdictionByLocationId?.[id];
      return typeof jurisdiction==="string" && jurisdiction.trim().length>0;
    }) &&
    plan.employees.filter(e=>e.active).every(e=>{
      const classification=profile?.classificationByEmployeeId?.[e.id];
      return typeof classification==="string" && classification.trim().length>0;
    }));
}
type State = {
  work: WorkUnit[];
  selected: Array<string|null>;
  missing: Array<{unit:DemandUnit;reason:PlannerGap["reason"]}>;
  score: number;
};
function containsPinned(work:readonly WorkUnit[], employeeId:string, unit:DemandUnit) {
  const matching=work.filter(w=>w.pinned && w.employeeId===employeeId &&
    w.locationId===unit.locationId && w.end>unit.start && w.start<unit.end)
    .sort((a,b)=>a.start-b.start);
  let cursor=unit.start;
  for(const w of matching){
    if(w.start>cursor)return false;
    cursor=Math.max(cursor,w.end);
    if(cursor>=unit.end)return true;
  }
  return false;
}
function softPenalty(employeeId:string,unit:DemandUnit,plan:ExpandedPlan):number {
  const employee=plan.employees.find(e=>e.id===employeeId)!;
  const location=plan.locations.get(unit.locationId)!;
  const p=localParts(unit.start,location.timezone);
  const minute=p.hour*60+p.minute;
  let penalty=0;
  for(const pref of employee.preferences??[]){
    if(pref.confirmation!=="owner_confirmed"||pref.strength!=="soft"||
      pref.day_of_week!==p.weekday || p.date<pref.effective_from ||
      (pref.effective_to!=null&&p.date>pref.effective_to))continue;
    const [a,b]=[pref.start_local,pref.end_local].map(x=>{
      const [h,m]=x.slice(0,5).split(":").map(Number);
      return h*60+m;
    });
    const matching=pref.overnight?minute>=a||minute<b:minute>=a&&minute<b;
    if(matching)penalty+=pref.preference==="avoid"?45:-10;
  }
  return penalty;
}
function choiceScore(employeeId:string,unit:DemandUnit,plan:ExpandedPlan,
  objective:Objective,work:readonly WorkUnit[]):number {
  const employee=plan.employees.find(e=>e.id===employeeId)!;
  const minutes=(unit.end-unit.start)/60000;
  const rate=workerWageRate(employee);
  const unknown=rate===null ? 120_000 : rate*minutes/60;
  const owner=employee.isOwner ? minutes : 0;
  const worked=work.filter(w=>w.employeeId===employeeId)
    .reduce((n,w)=>n+(w.end-w.start)/60000,0);
  const target=employee.desiredWeeklyMinutes;
  const desiredPenalty=target==null?0:
    (Math.abs(worked+minutes-target)-Math.abs(worked-target))/10;
  const minimum=employee.minWeeklyMinutes;
  const minHoursPenalty=minimum==null?0:
    (Math.max(0,minimum-worked-minutes)-Math.max(0,minimum-worked))/10;
  const preference=softPenalty(employeeId,unit,plan);
  const preferenceAndHours=preference+desiredPenalty+minHoursPenalty;
  // Unknown wage is deliberately NOT treated as free. Owner hours are
  // always visible, and the owner_time scenario strongly avoids them.
  if(objective==="owner_time")return owner*300+unknown/30+preferenceAndHours;
  if(objective==="cash")return unknown+owner*2+preferenceAndHours*2;
  return unknown/20+owner*25+preferenceAndHours*4;
}
function chunkReason(unit:DemandUnit,plan:ExpandedPlan,input:PlannerInput,
  options:readonly string[],work:readonly WorkUnit[]):PlannerGap["reason"] {
  if(options.length===0)return "no_confirmed_availability";
  const reasons=options.map((id):PlannerGap["reason"]=>{
    const employee=plan.employees.find(e=>e.id===id)!;
    const existing=work.filter(w=>w.employeeId===id);
    if(existing.some(w=>w.start<unit.end && unit.start<w.end))
      return "capacity_or_overlap";
    const duration=(unit.end-unit.start)/60000;
    const used=existing.reduce((n,w)=>n+(w.end-w.start)/60000,0);
    if(employee.maxWeeklyMinutes!=null && used+duration>employee.maxWeeklyMinutes)
      return "weekly_hour_limit";
    const daily=new Map<string,number>();
    for(const w of [...existing,{employeeId:id,locationId:unit.locationId,
      start:unit.start,end:unit.end,pinned:false}]){
      const zone=plan.locations.get(w.locationId)!.timezone;
      for(let t=w.start;t<w.end;t+=60000){
        const local=localParts(t,zone).date;
        const minutes=(daily.get(local)??0)+1;
        daily.set(local,minutes);
        if(employee.maxDailyMinutes!=null && minutes>employee.maxDailyMinutes)
          return "daily_hour_limit";
        const cap=employee.exceptions.filter(ex=>
          ex.confirmation==="owner_confirmed" &&
          ex.exception_type==="hours_cap" && ex.local_date===local &&
          (ex.location_id==null || ex.location_id===w.locationId) &&
          ex.max_minutes!=null).reduce((min,ex)=>Math.min(min,ex.max_minutes!),Infinity);
        if(minutes>cap)return "date_specific_cap";
      }
    }
    return "break_or_rest_constraint";
  });
  return reasons.every(r=>r===reasons[0])?reasons[0]:"capacity_or_overlap";
}
/** Add verified overlap at worker handoffs when the originally chosen
 * worker is already available before the transition. Extra work is paid and
 * explicitly revalidated; never assume undocumented availability.
 */
function repairHandoffs(input:PlannerInput,plan:ExpandedPlan,
  starting:readonly WorkUnit[],
  cache:Map<string,Array<{start:number;end:number}>>,
  reserved:readonly BreakReservation[]=[]):WorkUnit[] {
  const work=starting.slice();
  const grid=(input.slotMinutes??30)*60_000;
  const frozenUntil=input.replanAsOf==null?null:Date.parse(input.replanAsOf);
  let extraUnits=0;
  const covers=(workerId:string,unit:DemandUnit)=>
    work.some(w=>w.employeeId===workerId && w.locationId===unit.locationId &&
      w.start<=unit.start && w.end>=unit.end);
  for(const requirement of input.coverage){
    const overlap=requirement.minOverlapMinutes??0;
    if(requirement.priority!=="required" || overlap<=0 ||
      requirement.minHeadcount<=0)continue;
    const slices=new Map<number,DemandUnit>();
    for(const unit of plan.units)if(unit.coverageId===requirement.id &&
      !slices.has(unit.start))slices.set(unit.start,unit);
    const ordered=[...slices.values()].sort((a,b)=>a.start-b.start);
    for(let i=1;i<ordered.length;i++){
      const before=ordered[i-1],after=ordered[i];
      if(before.end!==after.start ||
        (frozenUntil!=null && after.start<frozenUntil))continue;
      const prev=plan.employees.filter(e=>qualifies(e,before,plan.locations) &&
        covers(e.id,before)).map(e=>e.id);
      const current=plan.employees.filter(e=>qualifies(e,after,plan.locations) &&
        covers(e.id,after)).map(e=>e.id).sort();
      if(prev.length===current.length && prev.every(id=>current.includes(id)))continue;
      const requiredStart=after.start-overlap*60_000;
      const sustained=(id:string)=> {
        for(let time=requiredStart;time<after.start;time+=grid){
          if(!covers(id,{...after,start:time,end:time+grid}))return false;
        }
        return true;
      };
      let continuous=current.filter(sustained).length;
      if(continuous>=requirement.minHeadcount)continue;
      for(const id of current){
        if(sustained(id))continue;
        const extra:WorkUnit[]=[];
        let acceptable=true;
        const employee=plan.employees.find(e=>e.id===id)!;
        for(let time=requiredStart;time<after.start;time+=grid){
          const piece:WorkUnit={employeeId:id,locationId:after.locationId,
            start:time,end:time+grid,pinned:false};
          if(covers(id,{...after,start:time,end:time+grid}))continue;
           if(reserved.some(b=>b.employeeId===id && b.start<time+grid && b.end>time)){
             acceptable=false;break;
           }
          if(!qualifies(employee,{...after,start:time,end:time+grid},plan.locations) ||
            !isConfirmedAvailable(piece,employee,plan.locations,cache)){
            acceptable=false;break;
          }
          extra.push(piece);
        }
        if(!acceptable || extraUnits+extra.length>2000 ||
          !hardValid([...work,...extra],plan,input))continue;
        work.push(...extra);extraUnits+=extra.length;
        continuous++;
        if(continuous>=requirement.minHeadcount)break;
      }
    }
  }
  return work;
}
function gapsFor(state:State):PlannerGap[] {
  const raw:PlannerGap[]=state.missing.map(({unit,reason})=>({
    coverageId:unit.coverageId,locationId:unit.locationId,
    startAt:utcIso(unit.start),endAt:utcIso(unit.end),
    qualificationCode:unit.qualificationCode,missingHeadcount:1,reason,
  }));
  const byKey=new Map<string,PlannerGap>();
  for(const gap of raw){
    const key=[gap.coverageId,gap.locationId,gap.startAt,gap.endAt,
      gap.qualificationCode,gap.reason].join("|");
    const existing=byKey.get(key);
    if(existing)existing.missingHeadcount++;
    else byKey.set(key,{...gap});
  }
  return [...byKey.values()].sort((a,b)=>a.startAt.localeCompare(b.startAt) ||
    a.locationId.localeCompare(b.locationId) || a.coverageId.localeCompare(b.coverageId));
}
function runObjective(input:PlannerInput,plan:ExpandedPlan,objective:Objective,
  cache:Map<string,Array<{start:number;end:number}>>,
  candidates:Map<string,string[]>,maxNodes:number,beamWidth:number,
   reserved:readonly BreakReservation[]=[]) {
  let frontier:State[]=[{work:plan.pinned.slice(),selected:[],missing:[],score:0}];
  let nodes=0,exhausted=false;
  for(const [index,unit] of plan.units.entries()){
    // Waive seats only in actively planned duty-free break windows; validator
    // independently checks that these reservations became real shift breaks.
    if(!demandSeatRequired(input,unit,reserved)){
      frontier=frontier.map(state=>({...state,selected:[...state.selected,null]}));
      continue;
    }
    const next:State[]=[];
    const activeBreaks=activeBreakReservations(unit,reserved);
    const options=(candidates.get(unit.id)??[]).filter(id=>
      !reserved.some(b=>b.employeeId===id && b.start<unit.end && b.end>unit.start));
    for(const state of frontier){
      const ranked=options.map(id=>({id,score:choiceScore(id,unit,plan,objective,state.work)}))
        .sort((a,b)=>a.score-b.score || a.id.localeCompare(b.id));
      for(const {id,score} of ranked){
        if(nodes>=maxNodes){exhausted=true;break;}
        nodes++;
        // One employee cannot satisfy two simultaneous coverage seats,
        // including two distinct overlapping location/role requirements.
        if(state.selected.some((chosen,prior)=>chosen===id &&
          plan.units[prior].start<unit.end && unit.start<plan.units[prior].end))continue;
        const pinned=containsPinned(state.work,id,unit);
        const added:WorkUnit={employeeId:id,locationId:unit.locationId,
          start:unit.start,end:unit.end,pinned:false};
        const work=pinned?state.work:[...state.work,added];
        if(!hardValid(work,plan,input))continue;
        next.push({work,selected:[...state.selected,id],missing:state.missing,
          score:state.score+score});
      }
      // Partial plans are evidence, never falsely declared fully feasible.
      // Advisory gaps remain separately visible without upgrading coverage.
      const reason=baselineGapReason(unit,plan,cache);
      next.push({work:state.work,selected:[...state.selected,null],
        missing:[...state.missing,{unit,reason:activeBreaks.length>0
          ?"break_coverage_unsatisfiable" :
          reason==="capacity_or_overlap"?chunkReason(unit,plan,input,options,state.work):reason}],
        score:state.score+(unit.priority==="required"?1_000_000:1_000)});
      if(exhausted)break;
    }
    next.sort((a,b)=>{
      const hardGaps=(s:State)=>s.missing.filter(m=>m.unit.priority==="required").length;
      return hardGaps(a)-hardGaps(b) || a.missing.length-b.missing.length ||
        a.score-b.score ||
        a.selected.join(",").localeCompare(b.selected.join(","));
    });
    frontier=next.slice(0,beamWidth);
    if(frontier.length===0 || exhausted) {
      // Remaining demand is explicitly unresolved when search budget ends.
      // The current demand unit was already accounted for (assigned or
      // marked missing). Never add it a second time on search exhaustion.
      const tail=plan.units.slice(index+1);
      const state=frontier[0]??{work:plan.pinned,selected:[],missing:[],score:0};
      for(const rest of tail)state.missing.push({unit:rest,reason:"solver_budget"});
      frontier=[state];break;
    }
  }
  const best=frontier[0]!;
  const repairedWork=repairHandoffs(input,plan,best.work,cache,reserved);
  // A gap recorded early may become constrained by assignments made later.
  // Explain each unmet slot relative to the FINAL candidate work roster,
  // not just the partial state when the omission was first considered.
  const resolvedMissing=best.missing.map(m=>{
    if(m.reason==="solver_budget" || m.reason==="break_coverage_unsatisfiable")return m;
    const staticReason=baselineGapReason(m.unit,plan,cache);
    return {unit:m.unit,reason:staticReason==="capacity_or_overlap"
      ?chunkReason(m.unit,plan,input,candidates.get(m.unit.id)??[],repairedWork)
      :staticReason};
  });
  const gaps=gapsFor({...best,missing:resolvedMissing});
  const requiredMissing=best.missing.some(m=>m.unit.priority==="required");
  const cost=costForWork(input,plan,repairedWork);
  return {
    scenario:{
      objective,shifts:shiftsForWork(input,plan,repairedWork),gaps,
      completeCoverage:!requiredMissing && !exhausted,
      hardConstraintsSatisfied:hardValid(repairedWork,plan,input),
      ownerMinutes:cost.ownerMinutes,cost,
      preferencePenalty:best.score,exploredNodes:nodes,
      legalReview:hasReviewedLegalInputs(input,plan)?"verified_profile":"unverified_profile",
    } satisfies PlannerScenario,
    exhausted,
  };
}
function diff(a:number|null,b:number|null){
  return a===null||b===null?null:b-a;
}
/** Deterministic, side-effect-free seven-day beam planner.
 * Completeness is a proven witness when all hard slots fill; a bounded
 * search that fails to find such a witness is UNPROVEN, not an invented
 * global infeasibility proof. Every emitted shift is revalidated.
 */
export function optimizeOliviaWeek(input:PlannerInput):PlannerResult {
  const plan=expandPlannerInput(input);
  const cache=new Map<string,Array<{start:number;end:number}>>();
  const maxNodes=input.maxNodes??30_000,beamWidth=input.beamWidth??10;
  if(!Number.isSafeInteger(maxNodes)||maxNodes<100||maxNodes>200_000 ||
    !Number.isSafeInteger(beamWidth)||beamWidth<1||beamWidth>32)
    throw new Error("invalid_planner_input:search_budget");
  // Pinned shifts are commitments, never silently discarded. Validate
  // availability and cross-location limits before trying optimization.
  for(const w of plan.pinned){
    if(w.historical)continue; // already-published, not re-authorized against changed availability
    const employee=plan.employees.find(e=>e.id===w.employeeId)!;
    const eligible=eligibleCandidates({
      id:"pinned",coverageId:"pinned",locationId:w.locationId,
      start:w.start,end:w.end,qualificationCode:null,priority:"required",
    },plan,cache).some(e=>e.id===employee.id);
    if(!eligible)throw new Error("invalid_pinned_commitment:availability");
  }
  if(!hardValid(plan.pinned,plan,input))
    throw new Error("invalid_pinned_commitment:hard_constraints");
  const candidates=new Map<string,string[]>();
  const frozenUntil=input.replanAsOf==null?null:Date.parse(input.replanAsOf);
  const historical=plan.pinned.filter(w=>w.historical);
  for(const unit of plan.units){
    // A new roster may never invent a shift that began before this trusted
    // snapshot. Only previously published, exact frozen work covers past slots.
    const options=frozenUntil!=null && unit.start<frozenUntil
      ? plan.employees.filter(e=>containsPinned(historical,e.id,unit)).map(e=>e.id)
      : eligibleCandidates(unit,plan,cache).map(e=>e.id);
    candidates.set(unit.id,options.sort());
  }
  const reserved=hasBreakCoveragePolicy(input)
    ?proposeBreakReservations(input,plan,cache):[];
  const objectives:Objective[]=["cash","owner_time","balanced"];
  const outputs=objectives.map(objective=>runObjective(
    input,plan,objective,cache,candidates,maxNodes,beamWidth,reserved));
  const scenarios:PlannerScenario[]=[];
  const signatures=new Set<string>();
  for(const output of outputs){
    const scenario=output.scenario;
    // PR3 may receive independently edited drafts. Run the same independent
    // public validator now: a generated candidate never bypasses full
    // availability, headcount, skill, pinned and break rechecks.
    const verified=validateOliviaAssignments(input,scenario.shifts);
    if(!verified.valid || !verified.completeCoverage){
      scenario.hardConstraintsSatisfied=false;
      scenario.completeCoverage=false;
      // The independent validator can discover uncovered handoff periods
      // or simultaneous qualified-headcount shortfalls invisible to the
      // greedy candidate selector. Return those EXACT periods to the owner.
      for(const gap of verified.gaps){
        if(!scenario.gaps.some(existing=>existing.coverageId===gap.coverageId &&
          existing.startAt===gap.startAt && existing.endAt===gap.endAt &&
          existing.reason===gap.reason))
          scenario.gaps.push(gap);
      }
      scenario.gaps.sort((a,b)=>a.startAt.localeCompare(b.startAt) ||
        a.locationId.localeCompare(b.locationId) || a.reason.localeCompare(b.reason));
    }
    const signature=scenario.shifts.map(s=>[s.employeeId,s.locationId,s.startAt,s.endAt].join(":"))
      .join("|")+"#"+scenario.gaps.map(g=>[g.coverageId,g.startAt,g.missingHeadcount].join(":")).join("|");
    if(!signatures.has(signature)){signatures.add(signature);scenarios.push(scenario);}
  }
  const best=scenarios.find(s=>s.completeCoverage && s.hardConstraintsSatisfied) ??
    scenarios[0]??null;
  const proofGap=plan.units.some(unit=>unit.priority==="required" &&
    (candidates.get(unit.id)?.length??0)===0);
  const status=best?.completeCoverage&&best.hardConstraintsSatisfied?"feasible":
    proofGap?"infeasible":"unproven";
  const comparisons:PlannerComparison[]=[];
  for(let i=1;i<scenarios.length;i++){
    const a=scenarios[0],b=scenarios[i];
    comparisons.push({left:a.objective,right:b.objective,
      ownerMinutesDifference:b.ownerMinutes-a.ownerMinutes,
      cashWagesDifferenceCents:diff(a.cost.cashWagesCents,b.cost.cashWagesCents),
      loadedPayrollDifferenceCents:diff(a.cost.loadedPayrollCents,b.cost.loadedPayrollCents)});
  }
  const warnings=plan.warnings.slice();
  if(hasBreakCoveragePolicy(input) &&
     (!input.ruleProfile?.verified ||
      input.ruleProfile.maxContinuousWorkMinutes==null))
    warnings.push("break_coverage_requires_reviewed_break_rules");
  if(scenarios.some(s=>s.gaps.some(g=>g.reason==="break_coverage_unsatisfiable")))
    warnings.push("break_coverage_unsatisfiable");
  if(!hasReviewedLegalInputs(input,plan))
    warnings.push("Jurisdiction, worker classification or rule-source evidence is incomplete; legal compliance is not verified");
  if(status==="unproven" && !outputs.some(o=>o.exhausted))
    warnings.push("Available workers exist, but no full roster satisfying all combined constraints was proven within bounded search");
  warnings.push("Bounded deterministic beam search yields verified feasible candidates, not a proof of globally minimum cost");
  if(outputs.some(o=>o.exhausted))warnings.push("Search budget exhausted; no global optimality or infeasibility proof");
  if(best && best.cost.missingWageEmployeeIds.length>0)
    warnings.push("Unknown or unverified wages prevent trustworthy total cash labor comparison");
  if(scenarios.some(s=>s.cost.allocatedSalaryCents!=null &&
    s.cost.allocatedSalaryCents>0))
    warnings.push("Salaried workers use allocated hourly-equivalent costs; these are not proven incremental cash payroll savings");
  if(plan.employees.some(e=>e.isOwner&&e.ownerOpportunityCentsPerHour==null) &&
    scenarios.some(s=>s.ownerMinutes>0))
    warnings.push("Owner hours have no verified economic opportunity cost and are not free business savings");
  if(plan.employees.some(e=>e.minWeeklyMinutes!=null))
    warnings.push("Minimum/desired employee hours influence scenario preferences; not a substitute for required coverage");
  return {
    status,horizonStart:input.horizonStart,horizonEnd:plan.horizonEnd,
    scenarios,best,comparisons,warnings,
    proof:status==="feasible"?"complete_candidate_solution":
      proofGap?"required_slot_has_no_eligible_worker":
      outputs.some(o=>o.exhausted)?"search_budget_exhausted":"candidate_constraints_unresolved",
  };
}
