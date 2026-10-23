import type {OpenHours} from "@/lib/business/openHours";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {minuteOfDay,elapsedMinutes,shiftCost,roleWageAverages,aggregateCosts,type CostShift,type CostLine} from "./shiftCost";
import {checkShiftLength,checkScheduledWeeklyBounds,type RuleSettings} from "./ruleChecks";

export type PersonForSchedule={id:string;name:string;role:string|null;wageCents:number|null;
 minWeeklyMinutes:number|null;maxWeeklyMinutes:number|null;availableDays:number[]|null;colorIndex:number|null};
export type DetailedShift=CostLine&{id:string;employeeName?:string;status?:string};
export type TimeWindow={start:string;end:string};
export type AvailabilityEntry={employee_id:string;day_of_week:number;start_local:string;end_local:string;
 effective_from:string;effective_to:string|null};
export type ScheduleGap={date:string;start:string;end:string;headcount:number;needed:number};

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
 const times=[300,1020,...intervals.flatMap(s=>[s.start,s.end]),
  ...dayShifts.flatMap(s=>{const d=span(s.start,s.end);return [d.start,d.end]})];
 const first=Math.floor(Math.min(...times)/60)*60;
 const last=Math.max(first+60,Math.ceil(Math.max(...times)/60)*60);
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
   const w=span(g.start,g.end);return {...band(w.start,w.end),...g};
  }),
  blocks:dayShifts.map((s,i)=>{
   const w=span(s.start,s.end);
   return {...band(w.start,w.end),id:s.id,employeeId:s.employeeId,top:i*30+2,
    title:(s.employeeName??"Team")+" "+s.start+"–"+s.end,estimated:s.estimated};
  }),
  height:Math.max(36,dayShifts.length*30+4)
 };
}
export function dayTotals(date:string,shifts:DetailedShift[]){
 const rows=shifts.filter(s=>s.date===date);
 return aggregateCosts(rows);
}
export function personTotals(personId:string,shifts:DetailedShift[]){
 return aggregateCosts(shifts.filter(s=>s.employeeId===personId));
}
export function totalOvertimeMinutes(people:PersonForSchedule[],shifts:DetailedShift[],afterMinutes:number,enabled:boolean){
 if(!enabled)return 0;
 return people.reduce((total,p)=>total+Math.max(0,personTotals(p.id,shifts).paidMinutes-afterMinutes),0);
}
export type AvailabilityStatus="free"|"off"|"on_shift"|"unavailable";
export function availabilityStatus(person:PersonForSchedule,date:string,start:string,end:string,
 shifts:DetailedShift[],windows:AvailabilityEntry[]):AvailabilityStatus{
 const day=dateDay(date);
 if(person.availableDays!==null&&!person.availableDays.includes(day))return "off";
 const sameDay=shifts.filter(s=>s.employeeId===person.id&&s.date===date);
 const range=span(start,end);
 if(sameDay.some(s=>{
  const on=span(s.start,s.end);return on.start<range.end&&range.start<on.end;
 }))return "on_shift";
 const valid=windows.filter(w=>w.employee_id===person.id&&w.day_of_week===day&&
   w.effective_from<=date&&(w.effective_to===null||w.effective_to>=date))
  .sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
 if(valid.length){
  const rangeAllowed=span(valid[0].start_local.slice(0,5),valid[0].end_local.slice(0,5));
  if(range.start<rangeAllowed.start||range.end>rangeAllowed.end)return "unavailable";
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
 windows:AvailabilityEntry[],rules:RuleSettings){
 const person=people.find(p=>p.id===input.employeeId);
 if(!person)return null;
 const originals=shifts.filter(s=>s.id!==input.editingId);
 const old=shifts.find(s=>s.id===input.editingId);
 const averages=roleWageAverages(people);
 const wage=person.role?averages.get(person.role.toLowerCase())??null:null;
 const overnight=input.end<input.start;
 let next:CostLine;
 try {next=shiftCost({employeeId:input.employeeId,date:input.date,start:input.start,end:input.end,
   breakMinutes:input.breakMinutes,overnight,wageCents:person.wageCents,role:person.role},wage);}
 catch{return null;}
 const before=aggregateCosts(shifts),without=aggregateCosts(originals);
 const projectedCost=without.knownCostCents+(next.costCents??0);
 const oldMinutes=personTotals(person.id,originals).paidMinutes;
 const hours=checkScheduledWeeklyBounds(oldMinutes+next.paidMinutes,person.minWeeklyMinutes,person.maxWeeklyMinutes);
 const length=checkShiftLength(input.start,input.end,input.breakMinutes,overnight,rules);
 const allGaps=gaps.filter(g=>g.date===input.date);
 const covered=allGaps.some(g=>{
  const gap=span(g.start,g.end),s=span(input.start,input.end);
  return s.start<=gap.start&&s.end>=gap.end&&g.headcount+1>=g.needed;
 });
 const overlap=availabilityStatus(person,input.date,input.start,input.end,originals,windows);
 const overtime=rules.weekly_ot_enabled&&oldMinutes+next.paidMinutes>rules.weekly_ot_after_minutes;
 const adjacent=originals.filter(s=>s.employeeId===person.id).map(s=>{
   const startMs=Date.parse(s.date+"T"+s.start+":00Z");
   const endMs=startMs+elapsedMinutes(s.start,s.end,s.overnight)*60000;
   const targetStart=Date.parse(input.date+"T"+input.start+":00Z");
   const targetEnd=targetStart+next.minutes*60000;
   const separation=targetStart>=endMs?(targetStart-endMs)/60000:
    startMs>=targetEnd?(startMs-targetEnd)/60000:Number.POSITIVE_INFINITY;
   return separation;
 }).filter(Number.isFinite);
 const rest=adjacent.length?Math.min(...adjacent):null;
 return {next,before:before.knownCostCents,after:projectedCost,
  estimated:before.estimated||next.estimated,unknown:before.unknownCount+(next.unknown?1:0),
  oldCostCents:old?.costCents??null,covered,availability:overlap,
  previousMinutes:oldMinutes,projectedMinutes:oldMinutes+next.paidMinutes,
  overtime,restMinutes:rest,shortRest:rules.min_rest_enabled&&rest!==null&&rest<rules.min_rest_minutes,
  tooLong:length.tooLong,tooShort:length.tooShort,belowMinimum:hours.belowMinimum,aboveMaximum:hours.aboveMaximum};
}
