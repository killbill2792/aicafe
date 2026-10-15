import type {PlannerShift} from "./plannerTypes";

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
  employeeId:string,locationId:string):PlannerShift {
  const last=shifts[shifts.length-1];
  const startAt=last?new Date(Date.parse(last.startAt)+86_400_000).toISOString():
    new Date(week+"T09:00:00.000Z").toISOString();
  const endAt=last?new Date(Date.parse(last.endAt)+86_400_000).toISOString():
    new Date(week+"T11:00:00.000Z").toISOString();
  return {employeeId,locationId,startAt,endAt,
    paidMinutes:(Date.parse(endAt)-Date.parse(startAt))/60_000,
    breaks:[],pinned:false};
}
