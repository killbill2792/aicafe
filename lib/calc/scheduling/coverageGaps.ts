import { minuteOfDay, type CostShift } from "./shiftCost";
import type { OpenHours } from "@/lib/business/openHours";
import { OPEN_HOURS_DAY_KEYS } from "@/lib/business/openHours";

export type CoverageGap={date:string;start:string;end:string;headcount:number;needed:number};
const clock=(m:number)=>String(Math.floor(m/60)%24).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
export function coverageGaps(dates:string[],shifts:CostShift[],openHours:OpenHours|null,needed:number):CoverageGap[]{
  if(!openHours || needed<1) return [];
  const result:CoverageGap[]=[];
  for(const date of dates){
    const [y,m,d]=date.split("-").map(Number);
    const day=OPEN_HOURS_DAY_KEYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
    const intervals=openHours[day];
    if(!intervals)continue; // Unknown trading hours are missing, not a full-day 'gap'.
    for(const [start,end] of intervals){
      let a=minuteOfDay(start),b=minuteOfDay(end);
      if(b<=a)b+=1440;
      const boundaries=new Set([a,b]);
      const rows=shifts.filter(s=>s.date===date).map(s=>{
        const x=minuteOfDay(s.start),y=minuteOfDay(s.end)+(s.overnight?1440:0);
        boundaries.add(Math.max(a,Math.min(b,x)));
        boundaries.add(Math.max(a,Math.min(b,y)));
        return [x,y] as const;
      });
      const edges=[...boundaries].sort((x,y)=>x-y);
      for(let i=0;i<edges.length-1;i++){
        const left=edges[i],right=edges[i+1];
        if(right<=left)continue;
        const count=rows.filter(([x,y])=>x<=left&&y>=right).length;
        if(count>=needed)continue;
        const prev=result[result.length-1];
        if(prev&&prev.date===date&&prev.headcount===count&&prev.end===clock(left)){
          prev.end=clock(right);
        }else result.push({date,start:clock(left),end:clock(right),headcount:count,needed});
      }
    }
  }
  return result;
}
