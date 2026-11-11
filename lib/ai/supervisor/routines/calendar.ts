import type {RoutineSchedule} from "./contracts";

const dayPattern=/^\d{4}-\d{2}-\d{2}$/u;
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string):Intl.DateTimeFormat {
  const existing=formatters.get(zone);
  if(existing)return existing;
  const next=new Intl.DateTimeFormat("en-GB",{
    timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  });
  formatters.set(zone,next);
  return next;
}
function localParts(utc:Date,zone:string):{date:string;time:string}{
  const parts=formatter(zone).formatToParts(utc);
  const field=(type:string)=>parts.find(p=>p.type===type)?.value??"";
  return {date:field("year")+"-"+field("month")+"-"+field("day"),
    time:field("hour")+":"+field("minute")};
}
export function localDateAt(instant:Date,zone:string):string{
  if(!Number.isFinite(instant.getTime()))throw new Error("Invalid routine instant");
  return localParts(instant,zone).date;
}
export function isScheduledOn(schedule:RoutineSchedule,localDate:string):boolean{
  if(!dayPattern.test(localDate))return false;
  const day=new Date(localDate+"T00:00:00Z");
  if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==localDate)return false;
  const weekday=day.getUTCDay()||7;
  return schedule.cadence==="daily" ||
    (schedule.cadence==="weekly"&&schedule.weekdays.includes(weekday));
}
/** Resolve a civil wall minute to the first eligible UTC minute on that local day.
 * A repeated fall-back minute chooses its FIRST occurrence. A spring-forward
 * missing minute chooses the first valid local minute after the gap. */
export function dueInstantForDate(localDate:string,localTime:string,zone:string):Date{
  if(!dayPattern.test(localDate)||!/^([01]\d|2[0-3]):[0-5]\d$/u.test(localTime))
    throw new Error("Invalid routine civil schedule");
  const wall=new Date(localDate+"T"+localTime+":00Z");
  if(!Number.isFinite(wall.getTime())||wall.toISOString().slice(0,10)!==localDate)
    throw new Error("Invalid routine local date");
  const base=wall.getTime();
  // Every IANA civil offset is within -12..+14 hours. The coarse search costs
  // at most 169 format calls, rather than scanning every UTC minute.
  for(let minute=-14*60;minute<=14*60;minute+=10){
    const at=base+minute*60_000;
    const civil=localParts(new Date(at),zone);
    if(civil.date!==localDate||civil.time<localTime)continue;
    // The earliest acceptable minute is in the preceding ten-minute window.
    for(let fine=minute-9;fine<=minute;fine++){
      const candidate=base+fine*60_000;
      const c=localParts(new Date(candidate),zone);
      if(c.date===localDate&&c.time>=localTime)return new Date(candidate);
    }
  }
  throw new Error("Routine local minute cannot be resolved");
}
export function dueScheduleOnDate(schedule:RoutineSchedule,zone:string,
  localDate:string,now:Date):Date|null{
  if(!isScheduledOn(schedule,localDate))return null;
  const due=dueInstantForDate(localDate,schedule.localTime,zone);
  return due.getTime()<=now.getTime()?due:null;
}
