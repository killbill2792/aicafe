import {fromZonedTime} from "date-fns-tz";
import type {OpenHours} from "@/lib/business/openHours";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {minuteOfDay,shiftCost,roleWageAverages,businessWageEstimate,aggregateCosts,type CostShift,type CostLine} from "./shiftCost";
import {checkShiftLength,checkScheduledWeeklyBounds,type RuleSettings} from "./ruleChecks";

export type PersonForSchedule={id:string;name:string;role:string|null;wageCents:number|null;
 minWeeklyMinutes:number|null;maxWeeklyMinutes:number|null;availableDays:number[]|null;colorIndex:number|null;
 active?:boolean};
export type DetailedShift=CostLine&{id:string;employeeName?:string;status?:string};
export type TimeWindow={start:string;end:string};
export type AvailabilityEntry={employee_id:string;day_of_week:number;start_local:string;end_local:string;
 effective_from:string;effective_to:string|null};
export type ScheduleGap={date:string;start:string;end:string;headcount:number;needed:number;shiftDate?:string};

const dateDay=(date:string)=>new Date(date+"T12:00:00Z").getUTCDay();
const span=(start:string,end:string)=>{
 const a=minuteOfDay(start),b=minuteOfDay(end);
 return {start:a,end:b<=a?b+1440:b};
};
const percent=(minute:number,first:number,last:number)=>100*(minute-first)/(last-first);
export function dayTimeline(date:string,shifts:DetailedShift[],gaps:ScheduleGap[],hours:OpenHours|null){
 const dayShifts=shifts.filter(s=>s.date===date);
 const openings=hours?.[OPEN_HOURS_DAY_KEYS[dateDay(date)]]??[];
 const intervals=openings.map(([start,end])=>span(start,end));
 const times=[...intervals.flatMap(s=>[s.start,s.end]),
  ...dayShifts.flatMap(s=>{const d=span(s.start,s.end);return [d.start,d.end]})];
 const timeline=times.length?times:[300,1020];
 const first=Math.floor(Math.min(...timeline)/60)*60;
 const last=Math.max(first+60,Math.ceil(Math.max(...timeline)/60)*60);
 const band=(a:number,b:number)=>({left:Math.max(0,percent(a,first,last)),
   width:Math.max(0,percent(b,first,last)-percent(a,first,last))});
 const ticks=[] as {at:number;label:string}[];
 for(let m=first;m<=last;m+=120){
  const h=Math.floor(m/60)%24;
  ticks.push({at:percent(m,first,last),label:(h%12||12)+(h<12?"a":"p")});
 }
 if(ticks[ticks.length-1]?.at<100){
  const h=Math.floor(last/60)%24;ticks.push({at:100,label:(h%12||12)+(h<12?"a":"p")});
 }
 return {
  first,last,ticks,
  open:intervals.map(s=>band(s.start,s.end)),
  gaps:gaps.filter(g=>g.date===date).map(g=>{
   const w=span(g.start,g.end);
   // An overnight opening's 00:00-02:00 portion belongs after 24:00
   // on the opening date, not at the left edge of that day's timeline.
   const afterMidnight=intervals.some(o=>o.end>1440&&w.start<o.start&&
     w.end<=o.end-1440);
   const offset=afterMidnight?1440:0;
   return {...band(w.start+offset,w.end+offset),...g};
  }),
  blocks:dayShifts.map((s,i)=>{
   const w=span(s.start,s.end);
   return {...band(w.start,w.end),id:s.id,employeeId:s.employeeId,top:i*52+2,
    title:(s.employeeName??"Team")+" "+s.start+"–"+s.end,estimated:s.estimated};
  }),
  height:Math.max(52,dayShifts.length*52+4)
 };
}
export function dayTotals(date:string,shifts:DetailedShift[]){
 const rows=shifts.filter(s=>s.date===date);
 return aggregateCosts(rows);
}
/** Inactive people remain visible if any retained dated shift refers to them. */
export function peopleWithRetainedShifts<T extends {id:string;active:boolean}>(
 people:readonly T[],shifts:readonly {employeeId:string}[]):T[]{
 const retained=new Set(shifts.map(s=>s.employeeId));
 return people.filter(p=>p.active||retained.has(p.id));
}
export function personTotals(personId:string,shifts:DetailedShift[]){
 return aggregateCosts(shifts.filter(s=>s.employeeId===personId));
}
export function totalOvertimeMinutes(people:PersonForSchedule[],shifts:DetailedShift[],afterMinutes:number,enabled:boolean){
 if(!enabled)return 0;
 return people.reduce((total,p)=>total+Math.max(0,personTotals(p.id,shifts).paidMinutes-afterMinutes),0);
}
/** Distinct shift starts may be on adjacent dates; compare the full dated
 * intervals to avoid falsely marking an overnight worker as free. */
export function overlapsEmployeeShift(employeeId:string,date:string,start:string,end:string,
 shifts:DetailedShift[]):boolean{
 const base=Date.parse(date+"T00:00:00Z")/60000;
 const from=base+minuteOfDay(start);
 const until=base+minuteOfDay(end)+(end<start?1440:0);
 return shifts.some(s=>{
  if(s.employeeId!==employeeId)return false;
  const day=Date.parse(s.date+"T00:00:00Z")/60000;
  const left=day+minuteOfDay(s.start);
  const right=day+minuteOfDay(s.end)+(s.overnight?1440:0);
  return left<until&&from<right;
 });
}
export type AvailabilityStatus="free"|"off"|"on_shift"|"unavailable";
export function availabilityStatus(person:PersonForSchedule,date:string,start:string,end:string,
 shifts:DetailedShift[],windows:AvailabilityEntry[]):AvailabilityStatus{
 const day=dateDay(date);
 if(person.availableDays!==null&&!person.availableDays.includes(day))return "off";
 const range=span(start,end);
 if(overlapsEmployeeShift(person.id,date,start,end,shifts))return "on_shift";
 const valid=windows.filter(w=>w.employee_id===person.id&&w.day_of_week===day&&
   w.effective_from<=date&&(w.effective_to===null||w.effective_to>=date));
 if(valid.length){
  // The foundation permits multiple windows on a weekday. Their union,
  // including touching windows, must cover the full proposed shift.
  const spans=valid.map(w=>span(w.start_local.slice(0,5),w.end_local.slice(0,5)))
    .sort((a,b)=>a.start-b.start||a.end-b.end);
  let coveredUntil=range.start;
  for(const window of spans){
   if(window.start>coveredUntil)break;
   coveredUntil=Math.max(coveredUntil,window.end);
   if(coveredUntil>=range.end)return "free";
  }
  return "unavailable";
 }
 return "free";
}
export function bestFreePerson(people:PersonForSchedule[],date:string,start:string,end:string,
 shifts:DetailedShift[],availability:AvailabilityEntry[]):PersonForSchedule|null{
 return people.filter(p=>availabilityStatus(p,date,start,end,shifts,availability)==="free")
  .sort((a,b)=>personTotals(a.id,shifts).paidMinutes-personTotals(b.id,shifts).paidMinutes)[0]??null;
}
export function previewShift(input:{employeeId:string;date:string;start:string;end:string;breakMinutes:number;editingId:string|null},
 people:PersonForSchedule[],shifts:DetailedShift[],gaps:ScheduleGap[],
 windows:AvailabilityEntry[],rules:RuleSettings,timezone="UTC",boundaryShifts:DetailedShift[]=[]){
 const person=people.find(p=>p.id===input.employeeId);
 if(!person)return null;
 const originals=shifts.filter(s=>s.id!==input.editingId);
 const old=shifts.find(s=>s.id===input.editingId);
 const averages=roleWageAverages(people);
 const wage=person.role?averages.get(person.role.toLowerCase())??null:null;
 const overnight=input.end<input.start;
 let next:CostLine;
 try {next=shiftCost({employeeId:input.employeeId,date:input.date,start:input.start,end:input.end,
   breakMinutes:input.breakMinutes,overnight,wageCents:person.wageCents,role:person.role},wage,businessWageEstimate(people));}
 catch{return null;}
 const before=aggregateCosts(shifts),without=aggregateCosts(originals);
 const projectedCost=without.knownCostCents+(next.costCents??0);
 const oldMinutes=personTotals(person.id,originals).paidMinutes;
 const hours=checkScheduledWeeklyBounds(oldMinutes+next.paidMinutes,person.minWeeklyMinutes,person.maxWeeklyMinutes);
 const length=checkShiftLength(input.start,input.end,input.breakMinutes,overnight,rules);
 const allGaps=gaps.filter(g=>(g.shiftDate??g.date)===input.date);
 const covered=allGaps.some(g=>{
  const gap=span(g.start,g.end),s=span(input.start,input.end);
  return s.start<=gap.start&&s.end>=gap.end&&g.headcount+1>=g.needed;
 });
 const neighboring=[...originals,...boundaryShifts];
 const overlapDetected=overlapsEmployeeShift(person.id,input.date,input.start,input.end,neighboring);
 const overlap=availabilityStatus(person,input.date,input.start,input.end,neighboring,windows);
 const overtime=rules.weekly_ot_enabled&&oldMinutes+next.paidMinutes>rules.weekly_ot_after_minutes;
 const adjacent=neighboring.filter(s=>s.employeeId===person.id).map(s=>{
   const midnight=(date:string,time:string)=>fromZonedTime(date+"T"+time+":00",timezone).getTime();
   const endDate=(date:string,overnight:boolean)=>
     overnight?new Date(Date.parse(date+"T12:00:00Z")+86400000).toISOString().slice(0,10):date;
   const startMs=midnight(s.date,s.start);
   const endMs=midnight(endDate(s.date,Boolean(s.overnight)),s.end);
   const targetStart=midnight(input.date,input.start);
   const targetEnd=midnight(endDate(input.date,overnight),input.end);
   const separation=targetStart>=endMs?(targetStart-endMs)/60000:
    startMs>=targetEnd?(startMs-targetEnd)/60000:Number.POSITIVE_INFINITY;
   return separation;
 }).filter(Number.isFinite);
 const rest=adjacent.length?Math.min(...adjacent):null;
 return {next,before:before.knownCostCents,after:projectedCost,
  beforeUnknownCount:before.unknownCount,
  afterUnknownCount:without.unknownCount+(next.unknown?1:0),
  estimated:before.estimated||next.estimated,unknown:before.unknownCount+(next.unknown?1:0),
  oldCostCents:old?.costCents??null,covered,availability:overlap,overlapDetected,
  previousMinutes:oldMinutes,projectedMinutes:oldMinutes+next.paidMinutes,
  overtime,restMinutes:rest,shortRest:overlapDetected||(rules.min_rest_enabled&&rest!==null&&rest<rules.min_rest_minutes),
  tooLong:length.tooLong,tooShort:length.tooShort,belowMinimum:hours.belowMinimum,aboveMaximum:hours.aboveMaximum};
}
