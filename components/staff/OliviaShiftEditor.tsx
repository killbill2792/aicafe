"use client";

import { useLocale, useTranslations } from "next-intl";
import type { PlannerShift } from "@/lib/calc/scheduling/plannerTypes";

const thirty=30*60_000;
function move(value:string,delta:number):string {
  return new Date(Date.parse(value)+delta*thirty).toISOString();
}
function compensated(shift:PlannerShift):number {
  const unpaid=shift.breaks.filter(b=>!b.paid)
    .reduce((n,b)=>n+(Date.parse(b.endAt)-Date.parse(b.startAt))/60000,0);
  return (Date.parse(shift.endAt)-Date.parse(shift.startAt))/60000-unpaid;
}
function local(value:string,zone:string,locale:string) {
  try {
    return new Intl.DateTimeFormat(locale,{
      timeZone:zone,dateStyle:"medium",timeStyle:"short",
    }).format(new Date(value));
  } catch {return value;}
}

export default function OliviaShiftEditor({shifts,onChange,employees,locations,
  names,week,disabled}:{
  shifts:PlannerShift[];onChange:(next:PlannerShift[])=>void;
  employees:Record<string,string>;locations:Record<string,string>;
  names:Record<string,string>;week:string;disabled:boolean;
}) {
  const t=useTranslations("OliviaPlanning");
  const locale=useLocale();
  function update(index:number,change:Partial<PlannerShift>) {
    onChange(shifts.map((s,i)=>i===index?{...s,...change}:s));
  }
  function time(index:number,side:"startAt"|"endAt",delta:number) {
    const shift=shifts[index];
    const candidate={...shift,[side]:move(shift[side],delta)};
    update(index,{[side]:candidate[side],paidMinutes:compensated(candidate)});
  }
  function add() {
    const employeeId=Object.keys(employees)[0],locationId=Object.keys(locations)[0];
    if(!employeeId || !locationId || shifts.length>=200)return;
    const base=shifts[shifts.length-1];
    const startAt=base?new Date(Date.parse(base.startAt)+86_400_000).toISOString():
      new Date(week+"T09:00:00.000Z").toISOString();
    const endAt=base?new Date(Date.parse(base.endAt)+86_400_000).toISOString():
      new Date(week+"T11:00:00.000Z").toISOString();
    onChange([...shifts,{employeeId,locationId,startAt,endAt,
      paidMinutes:(Date.parse(endAt)-Date.parse(startAt))/60000,
      breaks:[],pinned:false}]);
  }
  function setUnpaidBreak(index:number,enabled:boolean){
    const shift=shifts[index];
    const breaks=enabled?[{
      startAt:move(shift.startAt,2),endAt:move(shift.startAt,3),paid:false,
    }]:[];
    update(index,{breaks,paidMinutes:compensated({...shift,breaks})});
  }
  return <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
    <h3 className="font-bold">{t("editTitle")}</h3>
    <p className="text-sm text-ink-muted">{t("editInstructions")}</p>
    {shifts.map((shift,index)=><div key={index}
      className="flex flex-col gap-2 rounded-xl bg-paper p-3">
      <div className="flex items-center justify-between gap-2">
        <strong>{t("shiftNumber",{number:index+1})}</strong>
        <button type="button" disabled={disabled || shift.pinned}
          className="min-h-12 px-3 underline disabled:opacity-50"
          onClick={()=>onChange(shifts.filter((_,i)=>i!==index))}>
          {t("removeShift")}
        </button>
      </div>
      <label className="flex flex-col gap-1">{t("employee")}
        <select disabled={disabled} value={shift.employeeId}
          className="min-h-12 rounded-lg border border-line bg-card px-3"
          onChange={e=>update(index,{employeeId:e.target.value})}>
          {Object.entries(employees).map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">{t("location")}
        <select disabled={disabled} value={shift.locationId}
          className="min-h-12 rounded-lg border border-line bg-card px-3"
          onChange={e=>update(index,{locationId:e.target.value})}>
          {Object.keys(locations).map(id=><option key={id} value={id}>{names[id]||id}</option>)}
        </select>
      </label>
      {(["startAt","endAt"] as const).map(side=><div key={side} className="flex flex-col gap-1">
        <span>{t(side==="startAt"?"shiftStart":"shiftEnd")} ({locations[shift.locationId]||"UTC"})</span>
        <div className="flex items-center justify-between gap-2">
          <button type="button" disabled={disabled || shift.pinned}
            className="min-h-12 min-w-12 rounded-full border border-line disabled:opacity-50"
            aria-label={t("earlier")} onClick={()=>time(index,side,-1)}>−30</button>
          <span className="text-sm text-center">{local(shift[side],
            locations[shift.locationId]||"UTC",locale)}</span>
          <button type="button" disabled={disabled || shift.pinned}
            className="min-h-12 min-w-12 rounded-full border border-line disabled:opacity-50"
            aria-label={t("later")} onClick={()=>time(index,side,1)}>+30</button>
        </div>
      </div>)}
      <label className="flex items-center gap-3">
        <input type="checkbox" disabled={disabled || shift.pinned}
          checked={shift.breaks.length===1 && !shift.breaks[0].paid}
          onChange={e=>setUnpaidBreak(index,e.target.checked)}
          className="size-5"/>
        {t("unpaidBreak")}
      </label>
      {shift.breaks.length>1 && <p className="text-sm">{t("existingBreaks")}</p>}
      <p className="text-sm text-ink-muted">{t("paidMinutes")}: {shift.paidMinutes}</p>
    </div>)}
    <button type="button" onClick={add}
      disabled={disabled || !Object.keys(employees).length || !Object.keys(locations).length ||
        shifts.length>=200}
      className="min-h-12 rounded-full border border-line px-3 font-semibold disabled:opacity-50">
      {t("addShift")}
    </button>
  </section>;
}
