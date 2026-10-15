import { localParts, utcIso } from "./plannerClock";
import { baselineGapReason, eligibleCandidates, expandPlannerInput,
  workerWageRate, type WorkUnit, type DemandUnit, type ExpandedPlan } from "./plannerCore";
import { costForWork, hardValid, shiftsForWork } from "./plannerRules";
import type {
  PlannerInput, PlannerResult, PlannerScenario, PlannerComparison, PlannerGap,
} from "./plannerTypes";

type Objective = PlannerScenario["objective"];
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
  const desiredPenalty=target==null?0:Math.abs(worked+minutes-target)/600;
  const preference=softPenalty(employeeId,unit,plan);
  // Unknown wage is deliberately NOT treated as free. Owner hours are
  // always visible, and the owner_time scenario strongly avoids them.
  if(objective==="owner_time")return owner*300+unknown/30+preference+desiredPenalty;
  if(objective==="cash")return unknown+owner*2+preference*2+desiredPenalty;
  return unknown/20+owner*25+preference*4+desiredPenalty*4;
}
function chunkReason(unit:DemandUnit,plan:ExpandedPlan,
  options:readonly string[],work:readonly WorkUnit[]):PlannerGap["reason"] {
  if(options.length===0)return "no_confirmed_availability";
  if(options.some(id=>work.some(w=>w.employeeId===id &&
    w.start<unit.end && unit.start<w.end)))return "capacity_or_overlap";
  return "break_or_rest_constraint";
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
  candidates:Map<string,string[]>,maxNodes:number,beamWidth:number) {
  let frontier:State[]=[{work:plan.pinned.slice(),selected:[],missing:[],score:0}];
  let nodes=0,exhausted=false;
  for(const [index,unit] of plan.units.entries()){
    const next:State[]=[];
    const options=candidates.get(unit.id)??[];
    for(const state of frontier){
      const ranked=options.map(id=>({id,score:choiceScore(id,unit,plan,objective,state.work)}))
        .sort((a,b)=>a.score-b.score || a.id.localeCompare(b.id));
      let produced=0;
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
        produced++;
      }
      // Partial plans are evidence, never falsely declared fully feasible.
      // Advisory gaps remain separately visible without upgrading coverage.
      const reason=baselineGapReason(unit,plan,cache);
      next.push({work:state.work,selected:[...state.selected,null],
        missing:[...state.missing,{unit,reason:
          reason==="capacity_or_overlap"?chunkReason(unit,plan,options,state.work):reason}],
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
      const tail=plan.units.slice(index+(exhausted?0:1));
      const state=frontier[0]??{work:plan.pinned,selected:[],missing:[],score:0};
      for(const rest of tail)state.missing.push({unit:rest,reason:"solver_budget"});
      frontier=[state];break;
    }
  }
  const best=frontier[0]!;
  const gaps=gapsFor(best);
  const requiredMissing=best.missing.some(m=>m.unit.priority==="required");
  const cost=costForWork(input,plan,best.work);
  return {
    scenario:{
      objective,shifts:shiftsForWork(input,plan,best.work),gaps,
      completeCoverage:!requiredMissing && !exhausted,
      hardConstraintsSatisfied:hardValid(best.work,plan,input),
      ownerMinutes:cost.ownerMinutes,cost,
      preferencePenalty:best.score,exploredNodes:nodes,
      legalReview:input.ruleProfile?.verified?"verified_profile":"unverified_profile",
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
  for(const unit of plan.units){
    candidates.set(unit.id,eligibleCandidates(unit,plan,cache).map(e=>e.id).sort());
  }
  const objectives:Objective[]=["cash","owner_time","balanced"];
  const outputs=objectives.map(objective=>runObjective(
    input,plan,objective,cache,candidates,maxNodes,beamWidth));
  const scenarios:PlannerScenario[]=[];
  const signatures=new Set<string>();
  for(const output of outputs){
    const scenario=output.scenario;
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
      proofGap?"required_slot_has_no_eligible_worker":"search_budget_exhausted",
  };
}
