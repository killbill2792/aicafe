"use client";

import type {ReactNode} from "react";

export type EventReport={
  status?:unknown;reportText?:unknown;observedDays?:unknown;expectedDays?:unknown;
  checklist?:unknown;days?:unknown;caveat?:unknown;
};
type ReportDay={date:string;actualCents:number|null;typicalCents:number|null;
  hours:Array<{hourLocal:number;actualCents:number;usualCents:number|null}>};
const cents=(x:unknown):number|null=>
  typeof x==="number"&&Number.isSafeInteger(x)?x:null;
export function safeEventReport(raw:unknown):{
  text:string|null;observedDays:number|null;expectedDays:number|null;
  done:number|null;total:number|null;days:ReportDay[];
}|null{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const r=raw as EventReport;
  const checklist=r.checklist&&typeof r.checklist==="object"?r.checklist as Record<string,unknown>:{};
  const days=Array.isArray(r.days)?r.days.flatMap((entry:unknown)=>{
    if(!entry||typeof entry!=="object")return [];
    const day=entry as Record<string,unknown>;
    if(typeof day.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day.date))return [];
    const hours=Array.isArray(day.hours)?day.hours.flatMap((item:unknown)=>{
      if(!item||typeof item!=="object")return [];
      const h=item as Record<string,unknown>;
      if(!Number.isInteger(h.hourLocal)||Number(h.hourLocal)<0||Number(h.hourLocal)>23||
        cents(h.actualCents)===null)return [];
      return [{hourLocal:Number(h.hourLocal),actualCents:cents(h.actualCents)!,
        usualCents:cents(h.usualCents)}];
    }):[];
    return [{date:day.date,actualCents:cents(day.actualCents),
      typicalCents:cents(day.typicalCents),hours}];
  }):[];
  return {text:typeof r.reportText==="string"&&r.reportText.trim()?r.reportText:null,
    observedDays:cents(r.observedDays),expectedDays:cents(r.expectedDays),
    done:cents(checklist.done),total:cents(checklist.total),days};
}
type Copy=(key:string,params?:Record<string,string|number>)=>string;
export function EventReportCard({report,status,currency,locale,t,onChat}:{
  report:unknown;status:string|null;currency:string|null;
  locale:"en"|"es"|"ar";t:Copy;onChat:()=>void;
}):ReactNode{
  if(status!=="complete"&&status!=="insufficient_evidence")return null;
  const parsed=safeEventReport(report);
  if(!parsed)return null;
  const count=(n:number|null)=>n===null?t("reportUnknown"):new Intl.NumberFormat(locale).format(n);
  const money=(n:number|null)=>n===null?t("reportUnknown"):currency?
    new Intl.NumberFormat(locale,{style:"currency",currency}).format(n/100):
    new Intl.NumberFormat(locale).format(n)+" ¢";
  return <section className="space-y-3 rounded-2xl border border-line bg-surface2 p-3 text-[17px]"
    aria-label={t("reportTitle")}>
    <h4 className="font-bold">{t("reportTitle")} · {status==="complete"?
      t("reportComplete"):t("reportIncomplete")}</h4>
    {parsed.text&&<p className="whitespace-pre-wrap" dir="auto">{parsed.text}</p>}
    <p>{t("reportDays",{actual:count(parsed.observedDays),expected:count(parsed.expectedDays)})}</p>
    <p>{t("reportChecklist",{done:count(parsed.done),total:count(parsed.total)})}</p>
    {!currency&&<p className="text-ink-muted">{t("reportCurrencyMissing")}</p>}
    {parsed.days.map(day=><details key={day.date} className="rounded-xl border border-line bg-card p-3">
      <summary className="min-h-12 cursor-pointer font-semibold">
        {day.date} · {t("reportActual")}: {money(day.actualCents)} · {t("reportUsual")}: {money(day.typicalCents)}
      </summary>
      <div className="mt-2 space-y-1">
        {day.hours.map(hour=><p key={hour.hourLocal} className="flex flex-wrap justify-between gap-2">
          <span>{String(hour.hourLocal).padStart(2,"0")}:00</span>
          <span>{t("reportActual")}: {money(hour.actualCents)}</span>
          <span>{t("reportUsual")}: {money(hour.usualCents)}</span>
        </p>)}
      </div>
    </details>)}
    <p className="text-ink-muted">{t("reportNonCausal")}</p>
    <button type="button" onClick={onChat}
      className="min-h-12 rounded-xl bg-card px-4 font-semibold text-accent-text underline">
      {t("chatAbout")}
    </button>
  </section>;
}
