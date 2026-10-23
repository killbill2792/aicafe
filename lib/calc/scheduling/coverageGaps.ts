import { minuteOfDay, type CostShift } from "./shiftCost";
import type { OpenHours } from "@/lib/business/openHours";
import { OPEN_HOURS_DAY_KEYS } from "@/lib/business/openHours";

export type CoverageGap={date:string;start:string;end:string;headcount:number;needed:number;shiftDate?:string};
export type CoverageVerification="checked"|"closed"|"unknown"|"disabled";
export function coverageVerification(date:string,openHours:OpenHours|null,enabled:boolean):CoverageVerification{
 if(!enabled)return "disabled";
 const day=new Date(date+"T12:00:00Z").getUTCDay();
 const windows=openHours?.[OPEN_HOURS_DAY_KEYS[day]];
 if(windows===undefined)return "unknown";
 return windows.length?"checked":"closed";
}
export function uncheckedCoverageDays(dates:string[],openHours:OpenHours|null,enabled:boolean):string[]{
 return dates.filter(date=>coverageVerification(date,openHours,enabled)==="unknown");
}

const civilDay=(date:string)=>Date.parse(date+"T00:00:00Z")/60000;
const nextCivilDay=(date:string)=>new Date(Date.parse(date+"T12:00:00Z")+86400000).toISOString().slice(0,10);
const clock=(minute:number)=>String(Math.floor(((minute%1440)+1440)%1440/60)).padStart(2,"0")+":"+
 String(((minute%60)+60)%60).padStart(2,"0");

/** Count unique people across dated openings, including previous/next-day
 * shifts. Civil minutes avoid UTC-week and DST-based weekday drift; actual
 * pay elapsed-time calculations are handled separately by shiftCost. */
export function coverageGaps(dates:string[],shifts:CostShift[],openHours:OpenHours|null,needed:number):CoverageGap[]{
 if(!openHours || needed<1)return [];
 const work=shifts.map(s=>{
  const base=civilDay(s.date),start=base+minuteOfDay(s.start);
  const end=base+minuteOfDay(s.end)+(s.overnight?1440:0);
  return {employeeId:s.employeeId,start,end};
 });
 const result:CoverageGap[]=[];
 for(const date of dates){
  const base=civilDay(date),weekday=new Date(date+"T12:00:00Z").getUTCDay();
  const intervals=openHours[OPEN_HOURS_DAY_KEYS[weekday]];
  if(!intervals)continue; // Missing hours are not zero coverage.
  for(const [opening,closing] of intervals){
   const start=base+minuteOfDay(opening);
   let end=base+minuteOfDay(closing);
   if(end<=start)end+=1440;
   const boundaries=new Set([start,end]);
   for(const row of work){
    if(row.start>=end||row.end<=start)continue;
    boundaries.add(Math.max(start,row.start));
    boundaries.add(Math.min(end,row.end));
   }
   const edges=[...boundaries].sort((a,b)=>a-b);
   for(let i=0;i<edges.length-1;i++){
    const left=edges[i],right=edges[i+1];
    if(right<=left)continue;
    const count=new Set(work.filter(s=>s.start<=left&&s.end>=right).map(s=>s.employeeId)).size;
    if(count>=needed)continue;
    const from=clock(left-base),to=clock(right-base);
    const prev=result[result.length-1];
    if(prev&&prev.date===date&&prev.headcount===count&&prev.end===from)prev.end=to;
    else result.push({date,start:from,end:to,headcount:count,needed,
      ...(left>=base+1440?{shiftDate:nextCivilDay(date)}:{})});
   }
  }
 }
 return result;
}
