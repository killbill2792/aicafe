import {formatInTimeZone} from "date-fns-tz";
import type {PlannerShift} from "./plannerTypes";

/** Common exact Olivia -> existing schedule approval row conversion.
 * The Staff UI and Supervisor must approve the same proposal bytes.
 */
export function oliviaProposalShifts(
 shifts:readonly PlannerShift[],timezones:Readonly<Record<string,string>>
){
 return shifts.map(shift=>{
  const zone=timezones[shift.locationId];
  if(!zone)throw new Error("Unknown Olivia schedule location");
  const start=new Date(shift.startAt),end=new Date(shift.endAt);
  const elapsed=Math.round((end.getTime()-start.getTime())/60000);
  return {employee_id:shift.employeeId,
   date:formatInTimeZone(start,zone,"yyyy-MM-dd"),
   start:formatInTimeZone(start,zone,"HH:mm"),
   end:formatInTimeZone(end,zone,"HH:mm"),
   break_minutes:Math.max(0,elapsed-shift.paidMinutes)};
 });
}
