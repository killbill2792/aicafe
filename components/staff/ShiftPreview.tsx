"use client";
import {useTranslations} from "next-intl";
import {previewShift,type PersonForSchedule,type DetailedShift,type ScheduleGap,type AvailabilityEntry} from "@/lib/calc/scheduling/schedulePresentation";
import {costCompleteness} from "@/lib/calc/scheduling/shiftCost";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";
const fmt=(c:number|null,currency:string)=>c==null?"Unknown":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(c/100);
export default function ShiftPreview({personId,date,start,end,breakMinutes,editingId,team,shifts,gaps,availability,boundaryShifts,coverageChecked,rules,currency,timezone}:{
 personId:string;date:string;start:string;end:string;breakMinutes:number;editingId:string|null;
 team:PersonForSchedule[];shifts:DetailedShift[];gaps:ScheduleGap[];availability:AvailabilityEntry[];
 boundaryShifts:DetailedShift[];coverageChecked:boolean;rules:RuleSettings;currency:string;timezone:string
}){
 const t=useTranslations("StaffSchedule");
 const money=(c:number|null)=>c==null?t("unknownWages"):fmt(c,currency);
 const weeklyCost=(knownCents:number,unknownCount:number)=>{
  const state=costCompleteness({knownCostCents:knownCents,unknownCount});
  return state==="unknown"?t("unknownWages"):
   state==="partial"?t("partialWages",{known:fmt(knownCents,currency),count:unknownCount}):
   fmt(knownCents,currency);
 };
 const result=previewShift({employeeId:personId,date,start,end,breakMinutes,editingId},team,shifts,gaps,availability,rules,timezone,boundaryShifts);
 if(!result)return <p role="alert" className="mt-4 rounded-xl bg-warn-soft p-3 text-warn-text">{t("shiftTimeError")}</p>;
 const checks=[
  ...(coverageChecked?[[result.covered,t("gapFilled"),t("gapRemains")] as const]:[]),
  [!result.overtime,t("noOvertime",{hours:result.projectedMinutes/60}),t("exceedsOvertime")],
  [!result.overlapDetected,t("noOverlap"),t("overlapWarning")],
  [!result.shortRest,result.restMinutes===null?t("noAdjacent"):t("hoursRest",{hours:(result.restMinutes/60).toFixed(1)}),t("shortRest")],
  [!result.tooLong&&!result.tooShort,t("withinShift"),t("outsideShift")],
  [result.availability==="free",t("availableForShift"),t("availabilityStatus",{status:t(result.availability==="off"?"off":result.availability==="on_shift"?"onShift":"unavailable")})],
  [!result.aboveMaximum,t("weeklyMaxOk"),t("weeklyMaxExceeded")]
 ] as const;
 return <section className="mt-4 rounded-[20px] bg-surface2 p-4">
  <div className="flex justify-between gap-2"><h3 className="font-bold">{t("shiftCost")}</h3><strong className="text-2xl">{money(result.next.costCents)}</strong></div>
  <p className="my-2 text-sm text-muted">{t("costBreakdown",{hours:(result.next.minutes/60).toFixed(1),break:breakMinutes,paid:(result.next.paidMinutes/60).toFixed(1)})}
    {result.next.wageCents!=null?" × "+fmt(result.next.wageCents,currency)+"/h":""}
    {result.next.estimated?" · "+t("estimate"):""}</p>
  {!coverageChecked&&<p className="mt-1 text-muted">{t("coverageNotChecked")}</p>}
  {checks.map(([okay,good,bad],i)=><p key={i} className={`mt-1 text-sm font-semibold ${okay?"text-pos":"text-neg"}`}>{okay?"✓ ":"⚠ "}{okay?good:bad}</p>)}
  <p className="mt-3 text-sm">{t("weekLabor",{before:weeklyCost(result.before,result.beforeUnknownCount),after:weeklyCost(result.after,result.afterUnknownCount)})}{result.estimated?" · "+t("estimated"):""}</p>
 </section>;
}
