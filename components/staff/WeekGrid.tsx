"use client";
import {useTranslations} from "next-intl";
import type {OpenHours} from "@/lib/business/openHours";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {dayTotals,personTotals,type DetailedShift,type PersonForSchedule,type ScheduleGap} from "@/lib/calc/scheduling/schedulePresentation";
const fmt=(value:number|null,currency:string)=>value===null?"—":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(value/100);
const h=(minutes:number)=>Number((minutes/60).toFixed(1))+" h";
export default function WeekGrid({dates,people,shifts,gaps,openHours,currency,readOnly,onAdd,onEdit}:{
 dates:string[];people:PersonForSchedule[];shifts:DetailedShift[];gaps:ScheduleGap[];
 openHours:OpenHours|null;currency:string;readOnly:boolean;
 onAdd:(date:string,personId:string)=>void;onEdit:(date:string,id:string)=>void
}){
 const t=useTranslations("StaffSchedule");
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
   <tbody>{people.map((person,index)=>{
    const week=personTotals(person.id,shifts);
    return <tr key={person.id} className="border-b border-line"><th scope="row" className="p-3 text-start">
     <div className="flex items-center gap-2"><span className="grid size-10 place-items-center rounded-full bg-accent-soft font-bold text-accent-text">{person.name[0]}</span>
     <div><strong>{person.name}</strong><div className="text-sm font-normal text-muted">{person.role??t("team")} · {person.wageCents==null?t("noWage"):fmt(person.wageCents,currency)+"/h"}</div></div></div></th>
     {dates.map(date=><td key={date} className="p-1.5 align-middle">
      {shifts.filter(s=>s.employeeId===person.id&&s.date===date).map(s=><button key={s.id}
       disabled={readOnly} onClick={()=>onEdit(date,s.id)} className={`min-h-12 w-full rounded-xl border px-2 py-1 text-start text-[13px] font-bold ${index%2?"border-pos/20 bg-pos-soft text-pos":"border-accent-text/20 bg-accent-soft text-accent-text"}`}>
       <span className="block">{s.start}–{s.end}</span><span className="block">{h(s.paidMinutes)} {t("paid")}{s.estimated?" · "+t("estimated"):""}</span></button>)}
      <button disabled={readOnly} aria-label={t("addPersonShift",{name:person.name,date})} onClick={()=>onAdd(date,person.id)}
       className="min-h-12 w-full text-muted hover:text-accent-text">+</button>
     </td>)}
     <td className="p-2 text-end font-bold">{h(week.paidMinutes)}<span className="block text-sm text-muted">{fmt(week.knownCostCents,currency)}{week.estimated?" "+t("estimated"):""}</span></td>
    </tr>;
   })}</tbody>
   <tfoot className="font-semibold"><tr className="bg-surface2"><th className="p-3 text-start">{t("dayTotal")}</th>
    {dates.map(date=>{const day=dayTotals(date,shifts);return <td key={date} className="p-2 text-center">{h(day.paidMinutes)}<span className="block text-sm text-muted">{fmt(day.knownCostCents,currency)}{day.estimated?" "+t("estimated"):""}</span></td>})}<td/></tr>
    <tr><th className="p-3 text-start">{t("coverage")}</th>{dates.map(date=>{
     const gap=gaps.find(g=>g.date===date);return <td key={date} className={`p-2 text-center text-sm ${gap?"text-neg":"text-pos"}`}>{gap?
      "⚠ "+t("coverageDetail",{start:gap.start,end:gap.end,count:gap.headcount}):"✓ "+t("allDayCoverage")}</td>
    })}<td/></tr></tfoot>
  </table></div>;
}
