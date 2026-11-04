"use client";
import {useTranslations} from "next-intl";
import {calendarDisplayRows,calendarRowKey,type CalendarEntry} from "@/lib/calc/scheduling/calendarEntries";
import type {OpenHours} from "@/lib/business/openHours";
import {coverageVerification} from "@/lib/calc/scheduling/coverageGaps";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {costCompleteness} from "@/lib/calc/scheduling/shiftCost";
import {dayTotals,personTotals,type DetailedShift,type PersonForSchedule,type ScheduleGap} from "@/lib/calc/scheduling/schedulePresentation";
const fmt=(value:number|null,currency:string)=>value===null?"—":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(value/100);
const h=(minutes:number)=>Number((minutes/60).toFixed(1))+" h";
export default function WeekGrid({dates,people,shifts,calendarEntries=[],gaps,openHours,currency,readOnly,coverageEnabled,onAdd,onEdit}:{
 dates:string[];people:PersonForSchedule[];shifts:DetailedShift[];calendarEntries?:CalendarEntry[];gaps:ScheduleGap[];
 openHours:OpenHours|null;currency:string;readOnly:boolean;coverageEnabled:boolean;
 onAdd:(date:string,personId:string)=>void;onEdit:(date:string,id:string)=>void
}){
 const t=useTranslations("StaffSchedule");
 const knownIds=new Set(people.map(p=>p.id));
 const displayRows=calendarDisplayRows(people,calendarEntries);
 const wageSummary=(value:{knownCostCents:number;unknownCount:number})=>{
  const status=costCompleteness(value);
  return status==="unknown"?t("unknownWages"):
   status==="partial"?t("partialWages",{known:fmt(value.knownCostCents,currency),count:value.unknownCount}):
   fmt(value.knownCostCents,currency);
 };
 const stamp=(date:string)=>new Intl.DateTimeFormat(undefined,{weekday:"short",day:"numeric",timeZone:"UTC"}).format(new Date(date+"T12:00:00Z"));
 return <div className="hidden overflow-x-auto rounded-[20px] border border-line bg-surface lg:block">
  <table className="w-full min-w-[960px] border-collapse text-start text-[15px]">
   <thead><tr className="border-b border-line"><th scope="col" className="min-w-48 p-3 text-start">{t("person")}</th>
    {dates.map(date=>{
     const [y,m,d]=date.split("-").map(Number);
     const weekday=new Date(Date.UTC(y,m-1,d)).getUTCDay();
     const windows=openHours?.[OPEN_HOURS_DAY_KEYS[weekday]];
     return <th key={date} scope="col" className={`min-w-28 p-2 text-center ${gaps.some(g=>g.date===date)?"text-neg":""}`}>
      <span className="block">{stamp(date)}</span><span className="text-sm font-medium text-muted">
       {windows===undefined?t("hoursNotSet"):windows.length?windows.map(w=>w.join("–")).join(", "):t("closed")}</span></th>;
    })}<th scope="col" className="p-3 text-end">{t("week")}</th></tr></thead>
   <tbody>{displayRows.map(({key,person,name},index)=>{
    const week=person?personTotals(person.id,shifts):null;
    return <tr key={key} className="border-b border-line"><th scope="row" className="p-3 text-start">
     <div className="flex items-center gap-2"><span className="grid size-10 place-items-center rounded-full bg-accent-soft font-bold text-accent-text">{name[0]}</span>
     <div><strong>{name}</strong>{person?.active===false&&
       <span className="ms-2 text-sm font-normal text-muted">({t("inactivePerson")})</span>}
       <div className="text-sm font-normal text-muted">{person? <>{person.role??t("team")} · {person.wageCents==null?t("noWage"):fmt(person.wageCents,currency)+"/h"}</> : t("toastPlannedLabel")}</div></div></div></th>
     {dates.map(date=><td key={date} className="p-1.5 align-middle">
      {shifts.filter(s=>s.employeeId===person?.id&&s.date===date).map(s=><button key={s.id}
       disabled={readOnly} onClick={()=>onEdit(date,s.id)} className={`min-h-12 w-full rounded-xl border px-2 py-1 text-start text-[13px] font-bold ${index%2?"border-pos/20 bg-pos-soft text-pos":"border-accent-text/20 bg-accent-soft text-accent-text"}`}>
       <span className="block">{s.start}–{s.end}</span><span className="block">{h(s.paidMinutes)} {t("paid")}{s.estimated?" · "+t("estimated"):""}</span></button>)}
      {calendarEntries.filter(e=>calendarRowKey(e,knownIds)===key&&e.date===date).map(e=><div key={e.id}
       className={`mb-1 rounded-lg border px-2 py-1 text-[13px] ${e.source==="ai_draft"?"border-dashed border-accent bg-accent-soft":e.source==="toast_actual"?"border-pos bg-pos-soft":"border-line bg-surface2"}`}>
       <span className="block font-semibold">{e.start}–{e.end}</span>
       <span className="block">{e.source==="toast_actual"?t("toastActualLabel"):e.source==="toast_planned"?t("toastPlannedLabel"):t("aiDraftLabel")}</span>
      </div>)}
      <button disabled={readOnly||!person||person.active===false} aria-label={t("addPersonShift",{name,date})} onClick={()=>{if(person)onAdd(date,person.id);}}
       className="min-h-12 w-full text-muted hover:text-accent-text">+</button>
     </td>)}
     <td className="p-2 text-end font-bold">{week?h(week.paidMinutes):"—"}<span className="block text-sm text-muted">{week?wageSummary(week):"—"}{week?.estimated?" "+t("estimated"):""}</span></td>
    </tr>;
   })}</tbody>
   <tfoot className="font-semibold"><tr className="bg-surface2"><th className="p-3 text-start">{t("dayTotal")}</th>
    {dates.map(date=>{const day=dayTotals(date,shifts);return <td key={date} className="p-2 text-center">{h(day.paidMinutes)}<span className="block text-sm text-muted">{wageSummary(day)}{day.estimated?" "+t("estimated"):""}</span></td>})}<td/></tr>
    <tr><th className="p-3 text-start">{t("coverage")}</th>{dates.map(date=>{
     const gap=gaps.find(g=>g.date===date),state=coverageVerification(date,openHours,coverageEnabled);
     const checked=state==="checked";
     const message=state==="disabled"?t("coverageDisabled"):state==="unknown"?t("coverageNotChecked"):
      state==="closed"?t("closed"):gap?
       "⚠ "+t("coverageDetail",{start:gap.start,end:gap.end,count:gap.headcount}):"✓ "+t("allDayCoverage");
     return <td key={date} className={`p-2 text-center text-sm ${checked?(gap?"text-neg":"text-pos"):"text-muted"}`}>{message}</td>
    })}<td/></tr></tfoot>
  </table></div>;
}
