import {formatInTimeZone} from "date-fns-tz";
export const addCalendarDays=(day:string,n:number)=>
 new Date(Date.parse(day+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export function localClock(now:Date,zone:string){
 const s=formatInTimeZone(now,zone,"yyyy-MM-dd HH:mm");
 return {today:s.slice(0,10),minutes:Number(s.slice(11,13))*60+Number(s.slice(14,16))};
}
export function eligibleClosedDay(now:Date,zone:string,closeoutHour:number){
 const c=localClock(now,zone);
 return c.minutes>=(closeoutHour+1)*60?addCalendarDays(c.today,-1):null;
}
export function deriveNextRunDay(run:{requested_from:string|null;requested_to:string|null;days_done:number}){
 if(!run.requested_from)return null;
 const day=addCalendarDays(run.requested_from,run.days_done);
 return !run.requested_to||day<=run.requested_to?day:null;
}
