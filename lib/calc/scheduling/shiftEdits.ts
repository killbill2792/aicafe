import type {PlannerShift} from "./plannerTypes";
import {civilDateAdd,localParts,wallToUtc} from "./plannerClock";

const halfHour=30*60_000;
function utcAfter(value:string,delta:number):string {
  return new Date(Date.parse(value)+delta*halfHour).toISOString();
}
function paidMinutes(shift:PlannerShift):number {
  const unpaid=shift.breaks.filter(b=>!b.paid)
    .reduce((sum,brk)=>sum+
      (Date.parse(brk.endAt)-Date.parse(brk.startAt))/60_000,0);
  return (Date.parse(shift.endAt)-Date.parse(shift.startAt))/60_000-unpaid;
}
function pad(value:number):string {return String(value).padStart(2,"0");}
export function oliviaLocalBoundaryValue(instant:string,zone:string):string {
  const part=localParts(Date.parse(instant),zone);
  return `${part.date}T${pad(part.hour)}:${pad(part.minute)}`;
}
export function setOliviaLocalBoundary(shift:PlannerShift,
  side:"startAt"|"endAt",value:string,zone:string):PlannerShift {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("invalid_local_shift_time");
  const instant=wallToUtc(value.slice(0,10),value.slice(11),zone);
  const changed={...shift,[side]:new Date(instant).toISOString()};
  return {...changed,paidMinutes:paidMinutes(changed)};
}
/** Pure editor transformations; final validity is ALWAYS independently
 * checked by validateOliviaAssignments before the server saves any roster.
 */
export function moveOliviaBoundary(shift:PlannerShift,
  side:"startAt"|"endAt",steps:number):PlannerShift {
  if(!Number.isInteger(steps) || steps<-48 || steps>48)
    throw new Error("invalid_shift_edit");
  const moved={...shift,[side]:utcAfter(shift[side],steps)};
  return {...moved,paidMinutes:paidMinutes(moved)};
}
export function setOliviaUnpaidBreak(shift:PlannerShift,enabled:boolean):PlannerShift {
  if(shift.breaks.length>1 || shift.breaks.some(b=>b.paid))
    throw new Error("complex_break_requires_review");
  const breaks=enabled?[{startAt:utcAfter(shift.startAt,2),
    endAt:utcAfter(shift.startAt,3),paid:false}]:[];
  const changed={...shift,breaks};
  return {...changed,paidMinutes:paidMinutes(changed)};
}
export function addOliviaShift(week:string,shifts:readonly PlannerShift[],
  employeeId:string,locationId:string,zone="UTC"):PlannerShift {
  const last=shifts[shifts.length-1];
  const lastLocal=last?localParts(Date.parse(last.startAt),zone).date:null;
  const nextDay=lastLocal?civilDateAdd(lastLocal,1):week;
  // Never append a Sunday assignment into an eighth day by accident.
  const localDay=nextDay>=week && nextDay<=civilDateAdd(week,6)?nextDay:week;
  const start=wallToUtc(localDay,"09:00",zone);
  const duration=last?Date.parse(last.endAt)-Date.parse(last.startAt):120*60_000;
  const startAt=new Date(start).toISOString();
  const endAt=new Date(start+duration).toISOString();
  return {employeeId,locationId,startAt,endAt,
    paidMinutes:(Date.parse(endAt)-Date.parse(startAt))/60_000,
    breaks:[],pinned:false};
}
