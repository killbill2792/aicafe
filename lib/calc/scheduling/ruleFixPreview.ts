import {scheduledShiftMinutes} from "./shiftInput";
export const STAFF_RULE_KEYS=["meal","rest_break","weekly_overtime","daily_overtime","short_rest"] as const;
export type StaffRuleKey=(typeof STAFF_RULE_KEYS)[number];
export const isStaffRuleKey=(key:unknown):key is StaffRuleKey=>STAFF_RULE_KEYS.some(x=>x===key);
type Shift={start:string;end:string;minutes:number;breakMinutes:number;paidMinutes:number};
type Rules={meal_break_minutes:number;weekly_ot_after_minutes:number;daily_ot_after_minutes:number};
type Change={start:string;end:string;breakMinutes:number};
/** Only suggestions justified by a matching SCHEDULED shift; historical timecards are never mutated.
 * If the schedule cannot prove a safe change, require manual owner review instead. */
export function suggestedRuleShiftChange(
 key:StaffRuleKey,shift:Shift,rules:Rules,dayPaid:number,weekPaid:number
):Change|null{
 const span=scheduledShiftMinutes(shift.start,shift.end);
 if(span===null)return null;
 if(key==="meal"){
  const breakMinutes=Math.max(shift.breakMinutes,rules.meal_break_minutes);
  return breakMinutes<span&&breakMinutes<=240&&breakMinutes!==shift.breakMinutes?
   {start:shift.start,end:shift.end,breakMinutes}:null;
 }
 // Paid rest-break evidence and short-rest adjacency cannot be represented as an unpaid
 // shift break; never invent a fix for them.
 if(key==="rest_break"||key==="short_rest")return null;
 const excess=(key==="daily_overtime"?dayPaid-rules.daily_ot_after_minutes:
  weekPaid-rules.weekly_ot_after_minutes);
 const maxReduction=span-shift.breakMinutes-1;
 if(!Number.isInteger(excess)||excess<=0||excess>maxReduction)return null;
 const raw=Number(shift.end.slice(0,2))*60+Number(shift.end.slice(3));
 const end=((raw-excess)%1440+1440)%1440;
 const endClock=String(Math.floor(end/60)).padStart(2,"0")+":"+String(end%60).padStart(2,"0");
 return {start:shift.start,end:endClock,breakMinutes:shift.breakMinutes};
}
