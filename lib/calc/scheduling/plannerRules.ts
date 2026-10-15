import { roundHalfUpToCent } from "../money";
import { payrollTaxCents, staffCostLoadedCents } from "../staff";
import { localParts, utcIso } from "./plannerClock";
import { workerWageRate } from "./plannerCore";
import type { PlannerInput, PlannerShift, PlannerCost } from "./plannerTypes";
import type { ExpandedPlan, WorkUnit } from "./plannerCore";

const minutes = (w:WorkUnit)=>(w.end-w.start)/60000;

/** Validate every committed work minute against employee-wide weekly/daily
 * hard caps, confirmed local-day exceptions, owner-configured rest and meal
 * constraints. Never infer a jurisdiction's law when no verified profile exists.
 */
export function hardValid(works:readonly WorkUnit[], plan:ExpandedPlan, input:PlannerInput):boolean {
  const byEmployee=new Map<string,WorkUnit[]>();
  for(const w of works){
    if(w.end<=w.start || w.start%60000!==0 || w.end%60000!==0)return false;
    if(!plan.locations.has(w.locationId))return false;
    const employee=plan.employees.find(e=>e.id===w.employeeId);
    if(!employee || !employee.active)return false;
    const rows=byEmployee.get(w.employeeId)??[];
    rows.push(w);byEmployee.set(w.employeeId,rows);
  }
  for(const [id,rows] of byEmployee){
    const employee=plan.employees.find(e=>e.id===id)!;
    rows.sort((a,b)=>a.start-b.start || a.end-b.end);
    let week=0,continuous=0,previous:WorkUnit|null=null;
    const daily=new Map<string,number>();
    const caps=new Map<string,number>();
    for(const w of rows){
      if(previous && w.start<previous.end)return false;
      const gap=previous?(w.start-previous.end)/60000:Infinity;
      let paidGap:WorkUnit|null=null;
      if(previous){
        const meal=input.ruleProfile?.unpaidMealMinutes;
        const rest=input.ruleProfile?.minRestBetweenShiftsMinutes;
        const asMeal=meal!=null && gap===meal;
        const paidRest=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
        const asPaidRest=paidRest!=null && gap===paidRest &&
          previous.locationId===w.locationId;
        if(gap>0 && !asMeal && !asPaidRest && rest!=null && gap<rest)return false;
        if(gap>0 && (asMeal || asPaidRest || (rest!=null&&gap>=rest)))continuous=0;
        if(asPaidRest)paidGap={employeeId:id,locationId:w.locationId,
          start:previous.end,end:w.start,pinned:false};
      }
      continuous+=minutes(w);
      if(input.ruleProfile?.maxContinuousWorkMinutes!=null &&
        continuous>input.ruleProfile.maxContinuousWorkMinutes)return false;
      previous=w;
      week+=minutes(w)+(paidGap?minutes(paidGap):0);
      if(employee.maxWeeklyMinutes!=null && week>employee.maxWeeklyMinutes)return false;
      // A dated cap is for the calendar day WHERE EACH minute occurs.
      // Traverse minute boundaries to handle midnight, overnight, offset
      // changes and co-owners scheduling different location timezones.
      for(const portion of paidGap?[paidGap,w]:[w]){
      const location=plan.locations.get(portion.locationId)!;
      for(let time=portion.start;time<portion.end;time+=60_000){
        const p=localParts(time,location.timezone),day=p.date;
        const used=(daily.get(day)??0)+1;
        daily.set(day,used);
        if(employee.maxDailyMinutes!=null&&used>employee.maxDailyMinutes)return false;
        for(const ex of employee.exceptions){
          if(ex.confirmation!=="owner_confirmed" ||
            ex.exception_type!=="hours_cap" || ex.local_date!==day ||
            (ex.location_id!=null && ex.location_id!==w.locationId) ||
            ex.max_minutes==null)continue;
          caps.set(day,Math.min(caps.get(day)??Infinity,ex.max_minutes));
        }
        if(used>(caps.get(day)??Infinity))return false;
      }
      }
    }
  }
  return true;
}
function money(value:number):number {
  if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)
    throw new Error("unrepresentable_scheduling_cost");
  return roundHalfUpToCent(value);
}
export function costForWork(input:PlannerInput, plan:ExpandedPlan,
  works:readonly WorkUnit[]):PlannerCost {
  let wages=0,allocatedSalary=0,hasSalary=false,ownerMinutes=0,ownerOpportunity=0,ownerUnknown=false;
  const missing:string[]=[];
  const byEmployee=new Map<string,WorkUnit[]>();
  for(const w of works){
    const rows=byEmployee.get(w.employeeId)??[];
    rows.push(w);byEmployee.set(w.employeeId,rows);
  }
  for(const e of plan.employees){
    const rows=byEmployee.get(e.id);
    if(!rows?.length)continue;
    rows.sort((a,b)=>a.start-b.start);
    // Paid rest minutes remain payable while they provide NO coverage.
    // Only a verified configured rest duration may bridge two work segments.
    const billedRows=rows.slice();
    const restMinutes=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
    if(restMinutes!=null){
      for(let i=1;i<rows.length;i++){
        const previous=rows[i-1],current=rows[i];
        if(previous.locationId===current.locationId &&
          (current.start-previous.end)/60000===restMinutes)
          billedRows.push({employeeId:e.id,locationId:current.locationId,
            start:previous.end,end:current.start,pinned:false});
      }
    }
    billedRows.sort((a,b)=>a.start-b.start);
    const total=billedRows.reduce((n,w)=>n+minutes(w),0);
    if(e.isOwner){
      ownerMinutes+=total;
      if(e.ownerOpportunityCentsPerHour==null)ownerUnknown=true;
      else ownerOpportunity+=money(total*e.ownerOpportunityCentsPerHour/60);
    }
    const wageRate=workerWageRate(e);
    if(wageRate==null){missing.push(e.id);continue;}
    // Payroll base is rounded ONCE per employee, not separately for every
    // planning slot. No shift writes are made to historical timecards.
    let base=money(total*wageRate/60);
    const overtime=input.ruleProfile?.overtime;
    if(overtime?.verified){
      let week=0, premiumMinutes=0;
      const daily=new Map<string,number>();
      for(const w of billedRows){
        const zone=plan.locations.get(w.locationId)!.timezone;
        for(let t=w.start;t<w.end;t+=60000){
          const d=localParts(t,zone).date;
          const day=daily.get(d)??0;
          if((overtime.dailyAfterMinutes!=null && day>=overtime.dailyAfterMinutes) ||
            (overtime.weeklyAfterMinutes!=null && week>=overtime.weeklyAfterMinutes))
            premiumMinutes++;
          daily.set(d,day+1);week++;
        }
      }
      base+=money(premiumMinutes*wageRate*
        (overtime.multiplierNumerator-overtime.multiplierDenominator)/
        (60*overtime.multiplierDenominator));
    }
    if(e.wage.wage_period==="month" || e.wage.wage_period==="year"){
      // Salary is already owed according to employment terms. These cents
      // are an allocated cost-equivalent, NOT incremental payroll savings.
      hasSalary=true;allocatedSalary+=base;
    }
    wages+=base;
  }
  const available=missing.length===0;
  const rate=input.burden?.status==="unavailable"?null:input.burden?.rate??null;
  const loaded=available&&rate!=null
    ?staffCostLoadedCents(wages,money(payrollTaxCents(wages,rate))):null;
  return {
    cashWagesCents:available?wages:null,
    allocatedSalaryCents:available?allocatedSalary:null,
    loadedPayrollCents:loaded,
    ownerOpportunityCents:ownerUnknown?null:ownerOpportunity,
    ownerMinutes,
    costState:!available?"unavailable" :hasSalary?"estimate" :
      input.burden?.status==="verified"&&input.ruleProfile?.verified&&
      input.ruleProfile.overtime?.verified?"verified":"estimate",
    missingWageEmployeeIds:missing,
  };
}
export function shiftsForWork(input:PlannerInput,plan:ExpandedPlan,
  works:readonly WorkUnit[]):PlannerShift[] {
  const byEmployee=new Map<string,WorkUnit[]>();
  for(const w of works){
    const key=w.employeeId+"|"+w.locationId;
    const rows=byEmployee.get(key)??[];
    rows.push(w);byEmployee.set(key,rows);
  }
  const shifts:PlannerShift[]=[];
  for(const rows of byEmployee.values()){
    rows.sort((a,b)=>a.start-b.start);
    let first:WorkUnit|null=null,last:WorkUnit|null=null,paid=0,pinned=true;
    let breaks:PlannerShift["unpaidBreaks"]=[];
    function flush(){
      if(first && last)shifts.push({employeeId:first.employeeId,locationId:first.locationId,
        startAt:utcIso(first.start),endAt:utcIso(last.end),
        paidMinutes:paid,unpaidBreaks:breaks,pinned});
    }
    for(const w of rows){
      const gap=last?(w.start-last.end)/60000:Infinity;
      const meal=input.ruleProfile?.unpaidMealMinutes;
      const paidRest=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
      const restBreak=paidRest!=null && gap===paidRest;
      const sameShift=last && (gap===0 || (meal!=null&&gap===meal) || restBreak);
      if(!sameShift){
        flush();first=w;paid=0;pinned=true;breaks=[];
      } else if(gap>0 && last){
        breaks.push({startAt:utcIso(last.end),endAt:utcIso(w.start),paid:restBreak});
        if(restBreak)paid+=gap;
      }
      last=w;paid+=minutes(w);pinned=pinned&&w.pinned;
    }
    flush();
  }
  return shifts.sort((a,b)=>a.startAt.localeCompare(b.startAt) ||
    a.employeeId.localeCompare(b.employeeId) || a.locationId.localeCompare(b.locationId));
}
