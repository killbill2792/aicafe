export type ProposedStaffShift={employee_id:string;date:string;start:string;end:string;break_minutes:number};
const minute=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3,5));
const day=(date:string)=>Date.parse(date+"T00:00:00Z")/60000;
export function assertStaffShiftPlan(shifts:readonly ProposedStaffShift[]):void{
 const byEmployee=new Map<string,Array<{start:number;end:number}>>();
 for(const s of shifts){
  const startMinute=minute(s.start),endMinute=minute(s.end);
  const length=(endMinute<=startMinute?endMinute+1440:endMinute)-startMinute;
  if(!Number.isFinite(length)||length<=0||length>1440||s.break_minutes>=length)
   throw new Error("A shift's unpaid break must be shorter than the shift");
  const start=day(s.date)+startMinute,end=start+length;
  const existing=byEmployee.get(s.employee_id)??[];
  if(existing.some(e=>e.start<end&&e.end>start))
   throw new Error("Overlapping shifts for one employee");
  existing.push({start,end});byEmployee.set(s.employee_id,existing);
 }
}
