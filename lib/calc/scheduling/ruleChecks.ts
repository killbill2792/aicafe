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
 id:string;employeeId:string;start:string;end:string; // complete ISO instants
 breaks:{start:string;end:string;paid:boolean}[];
};
export type RuleViolation={timecardId:string;employeeId:string;key:"meal"|"rest_break"|"weekly_overtime"|"daily_overtime"|"short_rest";details:string};
export function localWeekStart(isoInstant:string,timezone:string):string {
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(isoInstant));
 const value=(key:string)=>parts.find(part=>part.type===key)?.value??"";
 const date=value("year")+"-"+value("month")+"-"+value("day");
 const weekday=new Date(date+"T12:00:00Z").getUTCDay();
 return new Date(Date.parse(date+"T12:00:00Z")-((weekday+6)%7)*86400000).toISOString().slice(0,10);
}
export function checkTimecardRules(cards:TimecardForRules[],rules:RuleSettings,timezone="UTC"):RuleViolation[]{
 const result:RuleViolation[]=[];
 const sorted=[...cards].sort((a,b)=>a.start.localeCompare(b.start));
 const prior=new Map<string,TimecardForRules>();
 const paidByWeek=new Map<string,number>();
 for(const card of sorted){
   const from=Date.parse(card.start),to=Date.parse(card.end);
   if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)continue;
   const minutes=(to-from)/60000;
   const breaks=card.breaks.filter(b=>Number.isFinite(Date.parse(b.start))&&Number.isFinite(Date.parse(b.end))&&
     Date.parse(b.end)>Date.parse(b.start));
   const unpaid=breaks.filter(b=>!b.paid).reduce((n,b)=>n+(Date.parse(b.end)-Date.parse(b.start))/60000,0);
   const rest=breaks.filter(b=>b.paid).reduce((n,b)=>n+(Date.parse(b.end)-Date.parse(b.start))/60000,0);
   const worked=Math.max(0,minutes-unpaid);
   const add=(key:RuleViolation["key"],details:string)=>result.push({timecardId:card.id,employeeId:card.employeeId,key,details});
   if(rules.meal_break_enabled&&minutes>rules.meal_break_after_minutes&&unpaid<rules.meal_break_minutes)
      add("meal","Meal break shorter than the configured minimum");
   if(rules.rest_break_enabled&&worked>=rules.rest_break_every_minutes&&
     rest<Math.floor(worked/rules.rest_break_every_minutes)*rules.rest_break_minutes)
      add("rest_break","Recorded paid rest breaks are shorter than expected");
   if(rules.daily_ot_enabled&&worked>rules.daily_ot_after_minutes)
      add("daily_overtime","Paid hours exceed the configured daily threshold");
   const key=card.employeeId+"|"+localWeekStart(card.start,timezone);
   const before=paidByWeek.get(key)??0;
   if(rules.weekly_ot_enabled&&before+worked>rules.weekly_ot_after_minutes)
      add("weekly_overtime","Paid hours exceed the configured weekly threshold");
   paidByWeek.set(key,before+worked);
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
