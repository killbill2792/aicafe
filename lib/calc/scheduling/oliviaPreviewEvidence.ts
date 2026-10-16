/**
 * Olivia PR4A read-side consistency witness for the PR2 planner result.
 * Pure computation only: no auth, database, LLM, Supervisor or mutation.
 * Mirrors PR2's published result invariants, close to its authoritative
 * implementation so producer and verifier can evolve together.
 */
import { civilDateAdd, localParts } from "./plannerClock";
import type { PlannerResult } from "./plannerTypes";

function overlapsReviewedWeek(
  startAt:string,endAt:string,timezone:string,
  week:string,weekEnd:string,prior:string,after:string,
):boolean {
  const start=Date.parse(startAt),end=Date.parse(endAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return false;
  const startLocal=localParts(start,timezone).date;
  // The final millisecond belongs to the prior civil date when an interval
  // ends at midnight, including across a DST transition.
  const endLocal=localParts(end-1,timezone).date;
  // Ordinary shifts/coverage start inside the week. Exact immutable
  // overnight published commitments may cross either weekly boundary.
  return startLocal>=prior && startLocal<=weekEnd &&
    endLocal>=week && endLocal<=after;
}
function delta(left:number|null,right:number|null):number|null {
  return left===null||right===null?null:right-left;
}

/** Validate PR2's deterministic result and actual location-local week.
 * All shapes, safe money ranges and UUID membership are validated by the
 * Olivia Zod adapter before this pure function is invoked.
 */
export function isCanonicalOliviaWeekResult(
  plan:PlannerResult,week:string,timezones:Record<string,string>,
):boolean {
  try {
    const end=civilDateAdd(week,6);
    if(plan.horizonStart!==week || plan.horizonEnd!==end)return false;
    const objectives=["cash","owner_time","balanced"] as const;
    if(plan.scenarios.length===0 || plan.scenarios[0].objective!=="cash" ||
       plan.scenarios.some((s,i)=>i>0 &&
         objectives.indexOf(s.objective)<=objectives.indexOf(plan.scenarios[i-1].objective)))
      return false;
    // optimizeOliviaWeek selects the FIRST feasible scenario, or the first
    // candidate when no complete hard-valid witness exists.
    const canonicalBest=plan.scenarios.find(s=>
      s.completeCoverage && s.hardConstraintsSatisfied)??plan.scenarios[0]??null;
    if(JSON.stringify(canonicalBest)!==JSON.stringify(plan.best))return false;
    const feasible=!!canonicalBest && canonicalBest.completeCoverage &&
      canonicalBest.hardConstraintsSatisfied;
    const outcomeConsistent=(
      (plan.status==="feasible" && feasible &&
        plan.proof==="complete_candidate_solution") ||
      (plan.status==="infeasible" && !feasible &&
        plan.proof==="required_slot_has_no_eligible_worker") ||
      (plan.status==="unproven" && !feasible &&
        (plan.proof==="search_budget_exhausted" ||
         plan.proof==="candidate_constraints_unresolved")));
    if(!outcomeConsistent)return false;
    // PR2 compares all scenarios after index 0 against the same first
    // candidate. Null cost comparisons remain null; never invent savings.
    if(plan.comparisons.length!==plan.scenarios.length-1)return false;
    const first=plan.scenarios[0];
    for(let i=0;i<plan.comparisons.length;i++){
      const right=plan.scenarios[i+1],row=plan.comparisons[i];
      if(row.left!==first.objective || row.right!==right.objective ||
         row.ownerMinutesDifference!==right.ownerMinutes-first.ownerMinutes ||
         row.cashWagesDifferenceCents!==delta(first.cost.cashWagesCents,
           right.cost.cashWagesCents) ||
         row.loadedPayrollDifferenceCents!==delta(first.cost.loadedPayrollCents,
           right.cost.loadedPayrollCents))
        return false;
    }
    const prior=civilDateAdd(week,-1),after=civilDateAdd(week,7);
    for(const scenario of plan.scenarios){
      for(const interval of [...scenario.shifts,...scenario.gaps]){
        const timezone=timezones[interval.locationId];
        if(!timezone || !overlapsReviewedWeek(interval.startAt,interval.endAt,
          timezone,week,end,prior,after))
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
