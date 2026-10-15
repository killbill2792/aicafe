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
    if(!employee || (!employee.active && !w.historical))return false;
    const rows=byEmployee.get(w.employeeId)??[];
    rows.push(w);byEmployee.set(w.employeeId,rows);
  }
  for(const [id,rows] of byEmployee){
    const employee=plan.employees.find(e=>e.id===id)!;
    rows.sort((a,b)=>a.start-b.start || a.end-b.end);
    let week=0,continuous=0,previous:WorkUnit|null=null;
    const daily=new Map<string,number>();
    const caps=new Map<string,number>();
    // Paid breaks in already-started immutable shifts are compensable but
    // never provide coverage. Count them toward future caps even if current
    // labor policy changed after the original publication.
    const historicalPaid=input.startedPublishedShifts?.filter(s=>s.employeeId===id)
      .flatMap(s=>s.breaks.filter(b=>b.paid).map(b=>({
        locationId:s.locationId,start:Date.parse(b.startAt),end:Date.parse(b.endAt),
      })))??[];
    for(const brk of historicalPaid){
      week+=(brk.end-brk.start)/60000;
      const zone=plan.locations.get(brk.locationId)!.timezone;
      for(let time=brk.start;time<brk.end;time+=60_000){
        const date=localParts(time,zone).date;
        daily.set(date,(daily.get(date)??0)+1);
      }
    }
    for(const w of rows){
      if(previous && w.start<previous.end)return false;
      const gap=previous?(w.start-previous.end)/60000:Infinity;
      let paidGap:WorkUnit|null=null;
      if(previous){
        const meal=input.ruleProfile?.unpaidMealMinutes;
        const rest=input.ruleProfile?.minRestBetweenShiftsMinutes;
        const asMeal=meal!=null && gap===meal;
        const paidRest=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
        const asPaidRest=paidRest!=null && paidRest>0 && gap===paidRest &&
          previous.locationId===w.locationId &&
          !(previous.historical && w.historical);
        if(gap>0 && !asMeal && !asPaidRest && rest!=null && gap<rest &&
          !(previous.historical && w.historical))return false;
        if(gap>0 && (asMeal || asPaidRest || (rest!=null&&gap>=rest)))continuous=0;
        if(asPaidRest)paidGap={employeeId:id,locationId:w.locationId,
          start:previous.end,end:w.start,pinned:false};
      }
      continuous+=minutes(w);
      if(!w.historical && input.ruleProfile?.maxContinuousWorkMinutes!=null &&
        continuous>input.ruleProfile.maxContinuousWorkMinutes)return false;
      previous=w;
      week+=minutes(w)+(paidGap?minutes(paidGap):0);
      if(!w.historical && employee.maxWeeklyMinutes!=null &&
        week>employee.maxWeeklyMinutes)return false;
      // A dated cap is for the calendar day WHERE EACH minute occurs.
      // Traverse minute boundaries to handle midnight, overnight, offset
      // changes and co-owners scheduling different location timezones.
      for(const portion of paidGap?[paidGap,w]:[w]){
      const location=plan.locations.get(portion.locationId)!;
      for(let time=portion.start;time<portion.end;time+=60_000){
        const p=localParts(time,location.timezone),day=p.date;
        const used=(daily.get(day)??0)+1;
        daily.set(day,used);
        if(!w.historical && employee.maxDailyMinutes!=null &&
          used>employee.maxDailyMinutes)return false;
        for(const ex of employee.exceptions){
          if(ex.confirmation!=="owner_confirmed" ||
            ex.exception_type!=="hours_cap" || ex.local_date!==day ||
            (ex.location_id!=null && ex.location_id!==w.locationId) ||
            ex.max_minutes==null)continue;
          caps.set(day,Math.min(caps.get(day)??Infinity,ex.max_minutes));
        }
        if(!w.historical && used>(caps.get(day)??Infinity))return false;
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
    for(const published of input.startedPublishedShifts??[]){
      if(published.employeeId!==e.id)continue;
      for(const brk of published.breaks.filter(b=>b.paid))
        billedRows.push({employeeId:e.id,locationId:published.locationId,
          start:Date.parse(brk.startAt),end:Date.parse(brk.endAt),
          pinned:true,historical:true});
    }
    const restMinutes=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
    if(restMinutes!=null && restMinutes>0){
      for(let i=1;i<rows.length;i++){
        const previous=rows[i-1],current=rows[i];
        if(previous.locationId===current.locationId &&
          !(previous.historical && current.historical) &&
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
    const publishedRate=input.historicalWageRates?.[e.id];
    const presentRate=workerWageRate(e);
    const hasOld=billedRows.some(w=>w.historical);
    const hasNew=billedRows.some(w=>!w.historical);
    // A missing historical wage is NOT permission to use today's rate.
    if((hasOld && publishedRate?.rateCentsPerHour==null) ||
       (hasNew && presentRate==null)){
      missing.push(e.id);continue;
    }
    const rateFor=(w:WorkUnit)=>w.historical
      ? publishedRate!.rateCentsPerHour! : presentRate!;
    const salaryFor=(w:WorkUnit)=>w.historical
      ? publishedRate?.salary===true
      : e.wage.wage_period==="month"||e.wage.wage_period==="year";
    // One base rounding per employee, even when old and new rates differ.
    let rawBase=0,rawSalary=0;
    for(const w of billedRows){
      const value=minutes(w)*rateFor(w)/60;
      rawBase+=value;
      if(salaryFor(w))rawSalary+=value;
    }
    let base=money(rawBase);
    let salaryBase=money(rawSalary);
    const overtime=input.ruleProfile?.overtime;
    if(overtime?.verified){
      let week=0,premium=0,salaryPremium=0;
      const factor=(overtime.multiplierNumerator-overtime.multiplierDenominator)/
        overtime.multiplierDenominator;
      const daily=new Map<string,number>();
      for(const w of billedRows){
        const zone=plan.locations.get(w.locationId)!.timezone;
        for(let t=w.start;t<w.end;t+=60000){
          const d=localParts(t,zone).date;
          const day=daily.get(d)??0;
          if((overtime.dailyAfterMinutes!=null && day>=overtime.dailyAfterMinutes) ||
            (overtime.weeklyAfterMinutes!=null && week>=overtime.weeklyAfterMinutes)){
            const premiumCent=rateFor(w)*factor/60;
            premium+=premiumCent;
            if(salaryFor(w))salaryPremium+=premiumCent;
          }
          daily.set(d,day+1);week++;
        }
      }
      base+=money(premium);
      salaryBase+=money(salaryPremium);
    }
    if(billedRows.some(salaryFor)){
      // Salary is already owed according to employment terms; this is an
      // allocated equivalent, not an incremental scheduling cost reduction.
      hasSalary=true;allocatedSalary+=salaryBase;
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
    if(w.historical)continue;
    const key=w.employeeId+"|"+w.locationId;
    const rows=byEmployee.get(key)??[];
    rows.push(w);byEmployee.set(key,rows);
  }
  const shifts:PlannerShift[]=[];
  for(const rows of byEmployee.values()){
    rows.sort((a,b)=>a.start-b.start);
    let first:WorkUnit|null=null,last:WorkUnit|null=null,paid=0,pinned=true;
    let breaks:PlannerShift["breaks"]=[];
    function flush(){
      if(first && last)shifts.push({employeeId:first.employeeId,locationId:first.locationId,
        startAt:utcIso(first.start),endAt:utcIso(last.end),
        paidMinutes:paid,breaks:breaks,pinned});
    }
    for(const w of rows){
      const gap=last?(w.start-last.end)/60000:Infinity;
      const meal=input.ruleProfile?.unpaidMealMinutes;
      const paidRest=input.ruleProfile?.verified?input.ruleProfile.paidRestMinutes:null;
      const restBreak=paidRest!=null && paidRest>0 && gap===paidRest;
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
  // Historical started shifts are immutable exact published assignments,
  // including their original paid/unpaid breaks, pay and pinned flag.
  shifts.push(...(input.startedPublishedShifts??[]).map(s=>({...s,
    breaks:s.breaks.map(b=>({...b}))})));
  return shifts.sort((a,b)=>a.startAt.localeCompare(b.startAt) ||
    a.employeeId.localeCompare(b.employeeId) || a.locationId.localeCompare(b.locationId));
}
