"use client";
import {useTranslations} from "next-intl";
import {previewShift,type PersonForSchedule,type DetailedShift,type ScheduleGap,type AvailabilityEntry} from "@/lib/calc/scheduling/schedulePresentation";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";
const fmt=(c:number|null,currency:string)=>c==null?"Unknown":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(c/100);
export default function ShiftPreview({personId,date,start,end,breakMinutes,editingId,team,shifts,gaps,availability,rules,currency,timezone}:{
 personId:string;date:string;start:string;end:string;breakMinutes:number;editingId:string|null;
 team:PersonForSchedule[];shifts:DetailedShift[];gaps:ScheduleGap[];availability:AvailabilityEntry[];
 rules:RuleSettings;currency:string;timezone:string
}){
 const t=useTranslations("StaffSchedule");
 const result=previewShift({employeeId:personId,date,start,end,breakMinutes,editingId},team,shifts,gaps,availability,rules,timezone);
 if(!result)return <p role="alert" className="mt-4 rounded-xl bg-warn-soft p-3 text-warn-text">{t("shiftTimeError")}</p>;
 const checks=[
  [result.covered,"Fills a coverage gap","Coverage gap remains"],
  [!result.overtime,t("noOvertime",{hours:result.projectedMinutes/60}),t("exceedsOvertime")],
  [!result.shortRest,result.restMinutes===null?t("noAdjacent"):t("hoursRest",{hours:(result.restMinutes/60).toFixed(1)}),t("shortRest")],
  [!result.tooLong&&!result.tooShort,t("withinShift"),t("outsideShift")],
  [result.availability==="free",t("availableForShift"),t("availabilityStatus",{status:result.availability.replace("_"," ")})],
  [!result.aboveMaximum,t("weeklyMaxOk"),t("weeklyMaxExceeded")]
 ] as const;
 return <section className="mt-4 rounded-[20px] bg-surface2 p-4">
  <div className="flex justify-between gap-2"><h3 className="font-bold">{t("shiftCost")}</h3><strong className="text-2xl">{fmt(result.next.costCents,currency)}</strong></div>
  <p className="my-2 text-sm text-muted">{t("costBreakdown",{hours:(result.next.minutes/60).toFixed(1),break:breakMinutes,paid:(result.next.paidMinutes/60).toFixed(1)})}
    {result.next.wageCents!=null?" × "+fmt(result.next.wageCents,currency)+"/h":""}
    {result.next.estimated?" · "+t("estimate"):""}</p>
  {checks.map(([okay,good,bad],i)=><p key={i} className={`mt-1 text-sm font-semibold ${okay?"text-pos":"text-neg"}`}>{okay?"✓ ":"⚠ "}{okay?good:bad}</p>)}
  <p className="mt-3 text-sm">{t("weekLabor",{before:fmt(result.before,currency),after:fmt(result.after,currency)})}<strong className="sr-only">{fmt(result.after,currency)}</strong>{result.estimated?" · "+t("estimated"):""}</p>
 </section>;
}
