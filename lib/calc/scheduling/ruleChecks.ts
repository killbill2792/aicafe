import {fromZonedTime} from "date-fns-tz";
import { elapsedMinutes, paidMinutes } from "./shiftCost";
export type RuleSettings={
 meal_break_enabled:boolean; meal_break_minutes:number; meal_break_after_minutes:number;
 rest_break_enabled:boolean; rest_break_minutes:number; rest_break_every_minutes:number;
 weekly_ot_enabled:boolean; weekly_ot_after_minutes:number;
 daily_ot_enabled:boolean; daily_ot_after_minutes:number;
 min_rest_enabled:boolean; min_rest_minutes:number;
 max_shift_enabled:boolean; max_shift_minutes:number;
 min_shift_enabled:boolean; min_shift_minutes:number;
};
export type TimecardForRules={
 id:string;employeeId:string;start:string;end:string;
 breaks:{start:string;end:string;paid:boolean}[];
};
export type RuleViolation={timecardId:string;employeeId:string;key:"meal"|"rest_break"|"weekly_overtime"|"daily_overtime"|"short_rest";details:string};

const localDate=(instant:number,timezone:string):string=>{
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(instant);
 const part=(type:string)=>parts.find(p=>p.type===type)?.value??"";
 return part("year")+"-"+part("month")+"-"+part("day");
};
const nextCivilDate=(date:string)=>new Date(Date.parse(date+"T12:00:00Z")+86400000).toISOString().slice(0,10);

export function localWeekStart(isoInstant:string,timezone:string):string {
 const date=localDate(Date.parse(isoInstant),timezone);
 const weekday=new Date(date+"T12:00:00Z").getUTCDay();
 return new Date(Date.parse(date+"T12:00:00Z")-((weekday+6)%7)*86400000).toISOString().slice(0,10);
}

/** Use a computed rule break until the owner explicitly enters an override.
 * Do not silently deduct a break when a rule is disabled or the shift is short. */
export function automaticUnpaidBreakMinutes(start:string,end:string,rules:Pick<RuleSettings,
 "meal_break_enabled"|"meal_break_minutes"|"meal_break_after_minutes">):number{
 if(start===end)return 0; // Let shift validation report the invalid window without crashing the editor.
 const minutes=elapsedMinutes(start,end,end<start);
 return rules.meal_break_enabled&&minutes>rules.meal_break_after_minutes?
   Math.min(240,minutes-1,rules.meal_break_minutes):0;
}

type Window={start:number;end:number};
function paidWindows(start:number,end:number,breaks:TimecardForRules["breaks"]):Window[]{
 const unpaid=breaks.filter(b=>!b.paid)
  .map(b=>({start:Math.max(start,Date.parse(b.start)),end:Math.min(end,Date.parse(b.end))}))
  .filter(b=>Number.isFinite(b.start)&&Number.isFinite(b.end)&&b.end>b.start)
  .sort((a,b)=>a.start-b.start);
 const windows:Window[]=[];
 let cursor=start;
 for(const b of unpaid){
  if(b.start>cursor)windows.push({start:cursor,end:b.start});
  cursor=Math.max(cursor,b.end);
 }
 if(cursor<end)windows.push({start:cursor,end});
 return windows;
}
/** Split actual paid work at business-local midnight, including DST boundaries.
 * Previous-week and previous-day buckets cannot absorb after-midnight hours. */
function perLocalDay(windows:Window[],timezone:string):Map<string,number>{
 const result=new Map<string,number>();
 for(const window of windows){
  let cursor=window.start;
  while(cursor<window.end){
   const date=localDate(cursor,timezone);
   const nextMidnight=fromZonedTime(nextCivilDate(date)+"T00:00:00",timezone).getTime();
   if(nextMidnight<=cursor)throw new Error("invalid_business_timezone_boundary");
   const stop=Math.min(window.end,nextMidnight);
   result.set(date,(result.get(date)??0)+(stop-cursor)/60000);
   cursor=stop;
  }
 }
 return result;
}
export function checkTimecardRules(cards:TimecardForRules[],rules:RuleSettings,timezone="UTC"):RuleViolation[]{
 const result:RuleViolation[]=[];
 const sorted=[...cards].sort((a,b)=>a.start.localeCompare(b.start));
 const prior=new Map<string,TimecardForRules>();
 const paidByDay=new Map<string,number>(),paidByWeek=new Map<string,number>();
 for(const card of sorted){
  const from=Date.parse(card.start),to=Date.parse(card.end);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)continue;
  const minutes=(to-from)/60000;
  const breaks=card.breaks.filter(b=>Number.isFinite(Date.parse(b.start))&&Number.isFinite(Date.parse(b.end))&&
    Date.parse(b.end)>Date.parse(b.start));
  const rest=breaks.filter(b=>b.paid).reduce((n,b)=>n+(Date.parse(b.end)-Date.parse(b.start))/60000,0);
  const daily=perLocalDay(paidWindows(from,to,breaks),timezone);
  const worked=[...daily.values()].reduce((n,m)=>n+m,0);
  const unpaid=minutes-worked;
  const add=(key:RuleViolation["key"],details:string)=>result.push({timecardId:card.id,employeeId:card.employeeId,key,details});
  if(rules.meal_break_enabled&&minutes>rules.meal_break_after_minutes&&unpaid<rules.meal_break_minutes)
     add("meal","Meal break shorter than the configured minimum");
  if(rules.rest_break_enabled&&worked>=rules.rest_break_every_minutes&&
    rest<Math.floor(worked/rules.rest_break_every_minutes)*rules.rest_break_minutes)
     add("rest_break","Recorded paid rest breaks are shorter than expected");
  let dailyExceeded=false,weeklyExceeded=false;
  for(const [date,paid] of daily){
   const dayKey=card.employeeId+"|"+date;
   const totalDay=(paidByDay.get(dayKey)??0)+paid;
   if(rules.daily_ot_enabled&&totalDay>rules.daily_ot_after_minutes)dailyExceeded=true;
   paidByDay.set(dayKey,totalDay);
   const week=localWeekStart(date+"T12:00:00Z","UTC");
   const weekKey=card.employeeId+"|"+week;
   const totalWeek=(paidByWeek.get(weekKey)??0)+paid;
   if(rules.weekly_ot_enabled&&totalWeek>rules.weekly_ot_after_minutes)weeklyExceeded=true;
   paidByWeek.set(weekKey,totalWeek);
  }
  if(dailyExceeded)add("daily_overtime","Paid hours exceed the configured daily threshold");
  if(weeklyExceeded)add("weekly_overtime","Paid hours exceed the configured weekly threshold");
  const prev=prior.get(card.employeeId);
  if(prev&&rules.min_rest_enabled&&from-Date.parse(prev.end)<rules.min_rest_minutes*60000)
     add("short_rest","Time between shifts is shorter than the configured minimum");
  prior.set(card.employeeId,card);
 }
 return result;
}
export function checkScheduledWeeklyBounds(paidPerWeek:number,minimum:number|null,maximum:number|null){
 return {belowMinimum:minimum!==null&&paidPerWeek<minimum,
   aboveMaximum:maximum!==null&&paidPerWeek>maximum};
}
export function checkShiftLength(start:string,end:string,breakMinutes:number,
 overnight:boolean,rules:Pick<RuleSettings,"max_shift_enabled"|"max_shift_minutes"|"min_shift_enabled"|"min_shift_minutes">){
 const minutes=elapsedMinutes(start,end,overnight);
 const paid=paidMinutes({start,end,breakMinutes,overnight});
 return {tooLong:rules.max_shift_enabled&&minutes>rules.max_shift_minutes,
   tooShort:rules.min_shift_enabled&&minutes<rules.min_shift_minutes,paid};
}
