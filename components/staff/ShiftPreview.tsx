"use client";
import {previewShift,type PersonForSchedule,type DetailedShift,type ScheduleGap,type AvailabilityEntry} from "@/lib/calc/scheduling/schedulePresentation";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";
const fmt=(c:number|null,currency:string)=>c==null?"Unknown":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(c/100);
export default function ShiftPreview({personId,date,start,end,breakMinutes,editingId,team,shifts,gaps,availability,rules,currency}:{
 personId:string;date:string;start:string;end:string;breakMinutes:number;editingId:string|null;
 team:PersonForSchedule[];shifts:DetailedShift[];gaps:ScheduleGap[];availability:AvailabilityEntry[];
 rules:RuleSettings;currency:string
}){
 const result=previewShift({employeeId:personId,date,start,end,breakMinutes,editingId},team,shifts,gaps,availability,rules);
 if(!result)return <p role="alert" className="mt-4 rounded-xl bg-warn-soft p-3 text-warn-text">Check the shift times and break length.</p>;
 const checks=[
  [result.covered,"Fills a coverage gap","Coverage gap remains"],
  [!result.overtime,result.projectedMinutes/60+" hours this week · no overtime","Weekly overtime threshold exceeded"],
  [!result.shortRest,result.restMinutes===null?"No adjacent shift recorded":(result.restMinutes/60).toFixed(1)+" hours between shifts","Rest between shifts is short"],
  [!result.tooLong&&!result.tooShort,"Shift length within rules","Shift length outside configured range"],
  [result.availability==="free","Available for this shift","Availability: "+result.availability.replace("_"," ")],
  [!result.aboveMaximum,"Weekly maximum is respected","Exceeds entered weekly maximum"]
 ] as const;
 return <section className="mt-4 rounded-[20px] bg-surface2 p-4">
  <div className="flex justify-between gap-2"><h3 className="font-bold">Cost of this shift</h3><strong className="text-2xl">{fmt(result.next.costCents,currency)}</strong></div>
  <p className="my-2 text-sm text-muted">{(result.next.minutes/60).toFixed(1)} h − {breakMinutes} min break = {(result.next.paidMinutes/60).toFixed(1)} h paid
    {result.next.wageCents!=null?" × "+fmt(result.next.wageCents,currency)+"/h":""}
    {result.next.estimated?" · Estimate":""}</p>
  {checks.map(([okay,good,bad],i)=><p key={i} className={`mt-1 text-sm font-semibold ${okay?"text-pos":"text-neg"}`}>{okay?"✓ ":"⚠ "}{okay?good:bad}</p>)}
  <p className="mt-3 text-sm">Week labor {fmt(result.before,currency)} → <strong>{fmt(result.after,currency)}</strong>{result.estimated?" · estimate":""}</p>
 </section>;
}
