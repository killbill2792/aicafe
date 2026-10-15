import { effectiveAvailabilityForLocation, compensationProvenance } from "./availability";
import { hourlyWageCentsFromSalary } from "../staff";
import { civilDateAdd, localParts, parseUtcInstant, weekday, wallToUtc, windowUtc } from "./plannerClock";
import type { PlannerEmployee, PlannerInput, PlannerLocation, PlannerGapReason } from "./plannerTypes";

export type DemandUnit = {
  id: string; coverageId: string; locationId: string;
  start: number; end: number; qualificationCode: string | null;
  priority: "required" | "advisory";
};
export type WorkUnit = { employeeId: string; locationId: string; start: number; end: number; pinned: boolean };
export type ExpandedPlan = {
  units: DemandUnit[]; pinned: WorkUnit[]; employees: PlannerEmployee[];
  locations: Map<string,PlannerLocation>; warnings: string[]; horizonEnd: string;
};

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error("invalid_planner_input:"+code);
}
export function expandPlannerInput(input: PlannerInput): ExpandedPlan {
  const endDate=civilDateAdd(input.horizonStart,6);
  const slot=input.slotMinutes??30;
  assert([5,10,15,30,60].includes(slot), "slot_granularity");
  assert(input.locations.length>0, "no_locations");
  assert(input.employees.length<=250 && input.coverage.length<=2000, "size");
  assert(new Set(input.locations.map(x=>x.id)).size===input.locations.length, "duplicate_location");
  assert(new Set(input.employees.map(x=>x.id)).size===input.employees.length, "duplicate_employee");
  assert(new Set(input.coverage.map(x=>x.id)).size===input.coverage.length, "duplicate_coverage");
  const locations=new Map(input.locations.map(l=>[l.id,l]));
  for(const location of locations.values()){
    assert(location.id.length>0, "location_id");
    try { new Intl.DateTimeFormat("en-US",{timeZone:location.timezone}); }
    catch { throw new Error("invalid_planner_input:location_timezone"); }
  }
  for(const e of input.employees){
    assert(e.id.length>0 && e.displayName.length>0, "employee");
    for(const number of [e.minWeeklyMinutes, e.desiredWeeklyMinutes,
      e.maxDailyMinutes,e.maxWeeklyMinutes,e.ownerOpportunityCentsPerHour,
      e.verifiedSalaryHourlyCents]) {
      assert(number==null || (Number.isSafeInteger(number) && number>=0), "employee_limits_or_cents");
    }
    assert(e.verifiedSalaryHoursPerWeek==null ||
      (Number.isFinite(e.verifiedSalaryHoursPerWeek) &&
        e.verifiedSalaryHoursPerWeek>0 && e.verifiedSalaryHoursPerWeek<=168),
      "verified_salary_weekly_hours");
    assert(e.maxDailyMinutes==null || e.maxDailyMinutes<=1440, "max_daily_minutes");
    assert(e.maxWeeklyMinutes==null || e.maxWeeklyMinutes<=10080, "max_weekly_minutes");
    if(e.maxWeeklyMinutes!=null && e.minWeeklyMinutes!=null)
      assert(e.minWeeklyMinutes<=e.maxWeeklyMinutes, "min_above_max");
  }
  if (input.ruleProfile){
    const r=input.ruleProfile;
    for(const n of [r.maxContinuousWorkMinutes,r.unpaidMealMinutes,r.paidRestMinutes,r.minRestBetweenShiftsMinutes])
      assert(n==null || (Number.isSafeInteger(n)&&n>=0 && n<=10080), "rule_minutes");
    if(r.maxContinuousWorkMinutes != null)
      assert((r.unpaidMealMinutes!=null && r.unpaidMealMinutes>0) ||
        (r.paidRestMinutes!=null && r.paidRestMinutes>0), "rest_rule_missing");
    if(r.paidRestMinutes!=null){
      assert(r.verified && r.paidRestMinutes>0 &&
        r.paidRestMinutes%slot===0,"unverified_or_unaligned_paid_rest");
      assert(r.paidRestMinutes!==r.unpaidMealMinutes,
        "ambiguous_paid_and_unpaid_break");
    }
    if(r.overtime) {
      for(const n of [r.overtime.dailyAfterMinutes,r.overtime.weeklyAfterMinutes,
        r.overtime.multiplierNumerator,r.overtime.multiplierDenominator])
        assert(n==null || (Number.isSafeInteger(n)&&n>=0), "overtime_rule");
      assert(r.overtime.multiplierDenominator>0 &&
        r.overtime.multiplierNumerator>=r.overtime.multiplierDenominator, "overtime_multiplier");
    }
  }
  if(input.burden) assert(Number.isFinite(input.burden.rate) &&
    input.burden.rate>=0 && input.burden.rate<=1, "payroll_burden");

  const warnings:string[]=[];
  const units:DemandUnit[]=[];
  for(const coverage of input.coverage){
    const location=locations.get(coverage.locationId);
    assert(location, "unknown_coverage_location");
    assert(coverage.id.length>0 && Number.isSafeInteger(coverage.minHeadcount) &&
      coverage.minHeadcount>=0 && coverage.minHeadcount<=30, "headcount");
    const duration=coverage.minOverlapMinutes??0;
    assert(Number.isSafeInteger(duration) && duration>=0 && duration<=1440,
      "minimum_overlap");
    // Overlap is a separate hard handoff invariant, not a larger solver slot.
    const chunk=slot;
    assert(duration%slot===0, "unaligned_minimum_overlap");
    assert((coverage.localDate==null)!==(coverage.dayOfWeek==null),
      "coverage_date_xor_weekday");
    if(coverage.dayOfWeek!=null) assert(Number.isInteger(coverage.dayOfWeek)&&
      coverage.dayOfWeek>=0&&coverage.dayOfWeek<=6, "weekday");
    if(coverage.effectiveFrom) civilDateAdd(coverage.effectiveFrom,0);
    if(coverage.effectiveTo) civilDateAdd(coverage.effectiveTo,0);
    if(coverage.localDate) civilDateAdd(coverage.localDate,0);
    for(let offset=0;offset<7;offset++){
      const date=civilDateAdd(input.horizonStart,offset);
      if(coverage.localDate?coverage.localDate!==date:
        coverage.dayOfWeek!==weekday(date) ||
        (coverage.effectiveFrom!=null&&date<coverage.effectiveFrom) ||
        (coverage.effectiveTo!=null&&date>coverage.effectiveTo)) continue;
      let interval:{startAt:number;endAt:number};
      try {interval=windowUtc(date,coverage.start_local,coverage.end_local,
        coverage.overnight,location.timezone);}
      catch(e){throw new Error(`invalid_coverage_wall_time:${coverage.id}:${String(e)}`);}
      const minutes=(interval.endAt-interval.startAt)/60000;
      assert(minutes%slot===0 && minutes>=chunk, "coverage_not_aligned");
      // Distribute an imperfect multiple of required overlap across
      // contiguous blocks, each AT LEAST the required overlap. E.g. a
      // 120-minute shift with minimum 45-minute blocks becomes 60+60, not
      // a rejected request or a final unsafe 30-minute fragment.
      const unitsTotal=minutes/slot,minimumUnits=chunk/slot;
      const parts=Math.floor(unitsTotal/minimumUnits);
      const baseSize=Math.floor(unitsTotal/parts),extras=unitsTotal%parts;
      let time=interval.startAt;
      for(let piece=0;piece<parts;piece++){
        const end=time+(baseSize+(piece<extras?1:0))*slot*60000;
        for(let seat=0;seat<coverage.minHeadcount;seat++)
          units.push({id:`${coverage.id}@${date}:${time}:${seat}`,
            coverageId:coverage.id,locationId:coverage.locationId,
            start:time,end,
            qualificationCode:coverage.qualificationCode??null,priority:coverage.priority});
        time=end;
      }
    }
  }
  assert(units.length<=1200, "coverage_slot_budget");
  units.sort((a,b)=>a.start-b.start || a.end-b.end ||
    a.locationId.localeCompare(b.locationId) || a.id.localeCompare(b.id));
  const pinned:WorkUnit[]=[];
  for(const p of input.pinned??[]){
    const location=locations.get(p.locationId);
    assert(location && input.employees.some(e=>e.id===p.employeeId), "pinned_scope");
    const start=parseUtcInstant(p.startAt),end=parseUtcInstant(p.endAt);
    assert(end>start && (end-start)/60000<=1440, "pinned_duration");
    assert((end-start)%(slot*60000)===0, "pinned_grid");
    const first=civilDateAdd(input.horizonStart,-1);
    assert(localParts(start,location.timezone).date>=first &&
      localParts(start,location.timezone).date<=endDate, "pinned_horizon");
    for(let time=start;time<end;time+=slot*60000)
      pinned.push({employeeId:p.employeeId,locationId:p.locationId,
        start:time,end:time+slot*60000,pinned:true});
  }
  if(input.coverage.every(c=>c.priority==="advisory"))
    warnings.push("Coverage requirements are advisory; no hard demand was supplied");
  if(!input.ruleProfile?.verified)
    warnings.push("Jurisdiction, employee classifications or labor/break rules are not verified; no legal compliance claim");
  if(!input.ruleProfile?.overtime?.verified)
    warnings.push("Overtime rules are unverified; modeled wages do not certify legal premiums");
  if(!input.burden || input.burden.status!=="verified")
    warnings.push("Payroll burden is unverified or unavailable; loaded labor may be an estimate");
  if(input.hourlySalesEvidence == null)
    warnings.push("Manual owner-entered coverage only; no hourly POS demand inferred");
  return {units,pinned,employees:input.employees,locations,warnings,horizonEnd:endDate};
}

/** Caller supplies its own cache per planning invocation; no cross-request
 * or cross-tenant data survives between planner calls.
 */
export function isConfirmedAvailable(work:WorkUnit, employee:PlannerEmployee,
  locations:Map<string,PlannerLocation>, cache:Map<string,Array<{start:number;end:number}>>) {
  const location=locations.get(work.locationId);
  if(!location || !employee.active) return false;
  if(employee.eligibleLocationIds && !employee.eligibleLocationIds.includes(location.id)) return false;
  const date=localParts(work.start,location.timezone).date;
  for(const d of [civilDateAdd(date,-1),date]) {
    const key=`${employee.id}|${location.id}|${d}`;
    let permitted=cache.get(key);
    if(!permitted){
      const projection=effectiveAvailabilityForLocation({
        date:d,locationId:location.id,
        recurring:employee.recurring,exceptions:employee.exceptions,
        restrictions:employee.preferences,
        hardUnavailability:employee.unavailableWeekdays,
      });
      permitted=[];
      for(const w of projection.windows){
        const convert=(minute:number)=>{
          const day=civilDateAdd(d,Math.floor(minute/1440));
          const m=minute%1440;
          return wallToUtc(day,
            `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`,
            location.timezone);
        };
        try {
          const start=convert(w.start),end=convert(w.end);
          if(end>start) permitted.push({start,end});
        }catch {
          // DST repeated/nonexistent boundary: never guess an available interval.
        }
      }
      cache.set(key,permitted);
    }
    if(permitted.some(w=>w.start<=work.start && work.end<=w.end)) return true;
  }
  return false;
}
export function qualifies(employee:PlannerEmployee, unit:DemandUnit,
  locations:Map<string,PlannerLocation>) {
  if(!unit.qualificationCode)return true;
  const loc=locations.get(unit.locationId);
  if(!loc)return false;
  const date=localParts(unit.start,loc.timezone).date;
  const finalDate=localParts(unit.end-60_000,loc.timezone).date;
  // Overnight work must remain qualified after local midnight, not only
  // on the starting day of the requirement.
  return employee.qualifications.some(q=>q.confirmed && q.code===unit.qualificationCode &&
    (q.locationId==null || q.locationId===unit.locationId) &&
    date>=q.validFrom && finalDate>=q.validFrom &&
    (q.validTo==null || (date<=q.validTo&&finalDate<=q.validTo)));
}
export function workerWageRate(employee:PlannerEmployee):number|null {
  const state=compensationProvenance({cash_cost_state:employee.provenance},employee.wage);
  if(state==="known_eligible_zero" && employee.eligibleZeroVerified===true) return 0;
  if(state!=="known_paid")return null;
  if(employee.wage.wage_period==="hour"){
    const cents=employee.wage.wage_amount_cents;
    return cents!=null && Number.isSafeInteger(cents) && cents>0 ? cents : null;
  }
  if(employee.verifiedSalaryHoursPerWeek!=null &&
    employee.verifiedSalaryHoursPerWeek>0 &&
    employee.wage.wage_amount_cents!=null){
    const period=employee.wage.wage_period;
    if(period==="month"||period==="year")
      return hourlyWageCentsFromSalary(employee.wage.wage_amount_cents,
        period, employee.verifiedSalaryHoursPerWeek);
  }
  return employee.verifiedSalaryHourlyCents != null &&
    Number.isSafeInteger(employee.verifiedSalaryHourlyCents) &&
    employee.verifiedSalaryHourlyCents>0 ? employee.verifiedSalaryHourlyCents : null;
}
export function eligibleCandidates(unit:DemandUnit, plan:ExpandedPlan,
  cache:Map<string,Array<{start:number;end:number}>>) {
  return plan.employees.filter(e=>qualifies(e,unit,plan.locations) &&
    isConfirmedAvailable({employeeId:e.id,locationId:unit.locationId,
      start:unit.start,end:unit.end,pinned:false},e,plan.locations,cache));
}
export function baselineGapReason(unit:DemandUnit,plan:ExpandedPlan,
  cache:Map<string,Array<{start:number;end:number}>>):PlannerGapReason {
  const active=plan.employees.filter(e=>e.active &&
    (!e.eligibleLocationIds || e.eligibleLocationIds.includes(unit.locationId)));
  if(active.length===0)return "no_active_staff";
  if(!active.some(e=>qualifies(e,unit,plan.locations)))return "qualification_missing";
  if(eligibleCandidates(unit,plan,cache).length===0)return "no_confirmed_availability";
  return "capacity_or_overlap";
}
