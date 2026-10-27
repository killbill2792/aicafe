import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

type PaidBreak = {start:string;end:string;paid:boolean};
export type PricedShift = {
  clockIn:string;clockOut:string|null;hourlyWageCents:number|null;
  breaks?:readonly PaidBreak[]|null;
};
const DAY_MS=86400000;
const nextDay=(day:string)=>new Date(Date.parse(day+"T12:00:00Z")+DAY_MS).toISOString().slice(0,10);
const validTime=(value:string)=>{
 const ms=Date.parse(value);
 if(!Number.isFinite(ms))throw new Error("Invalid timecard timestamp");
 return ms;
};

/** Return every café-local day touched by a nonempty paid-time interval.
 * The end is exclusive; a shift ending exactly at midnight does not
 * double-count the next day. Calendar arithmetic avoids DST day lengths.
 */
export function affectedLocalDays(start:string,end:string,timezone:string):string[]{
 const first=validTime(start),last=validTime(end);
 if(last<=first)throw new Error("Invalid closed timecard interval");
 const startDay=formatInTimeZone(first,timezone,"yyyy-MM-dd");
 const endDay=formatInTimeZone(last-1,timezone,"yyyy-MM-dd");
 const days:string[]=[];
 for(let day=startDay;day<=endDay;day=nextDay(day)){
  if(days.length>=31)throw new Error("Timecard interval exceeds 31 café-local days");
  days.push(day);
 }
 return days;
}

/** Splits a shift's actual paid duration by café-local midnight, including
 * time-zone/DST transitions and unpaid breaks. Wages remain nullable.
 * This is used only for actual timecards; scheduled hours aren't paid.
 */
export function timecardWagesForLocalDay(shift:PricedShift,day:string,
 timezone:string,now:Date=new Date()):number|null{
 if(shift.hourlyWageCents===null)return null;
 const start=fromZonedTime(day+"T00:00:00",timezone).getTime();
 const end=fromZonedTime(nextDay(day)+"T00:00:00",timezone).getTime();
 const inMs=validTime(shift.clockIn);
 const outMs=shift.clockOut?validTime(shift.clockOut):now.getTime();
 const effectiveOut=Math.min(outMs,now.getTime());
 const overlap=(a:number,b:number)=>
  Math.max(0,Math.min(end,b)-Math.max(start,a));
 const total=overlap(inMs,effectiveOut);
 const breaks=(shift.breaks??[]).filter(b=>!b.paid).reduce((n,b)=>
  n+overlap(Math.max(inMs,validTime(b.start)),
    Math.min(effectiveOut,validTime(b.end))),0);
 return Math.max(0,total-breaks)/3600000*shift.hourlyWageCents;
}
