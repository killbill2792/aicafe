"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { PlannerShift } from "@/lib/calc/scheduling/plannerTypes";
import {addOliviaShift,moveOliviaBoundary,setOliviaUnpaidBreak,
  oliviaLocalBoundaryValue,setOliviaLocalBoundary} from "@/lib/calc/scheduling/shiftEdits";

function local(value:string,zone:string,locale:string) {
  try {
    return new Intl.DateTimeFormat(locale,{
      timeZone:zone,dateStyle:"medium",timeStyle:"short",
    }).format(new Date(value));
  } catch {return value;}
}

export default function OliviaShiftEditor({shifts,onChange,employees,locations,
  names,week,disabled,frozenShiftKeys}:{
  shifts:PlannerShift[];onChange:(next:PlannerShift[])=>void;
  employees:Record<string,string>;locations:Record<string,string>;
  names:Record<string,string>;week:string;disabled:boolean;
  frozenShiftKeys:string[];
}) {
  const t=useTranslations("OliviaPlanning");
  const locale=useLocale();
  const [clockError,setClockError]=useState("");
  const frozenKeys=new Set(frozenShiftKeys);
  const isFrozen=(shift:PlannerShift)=>frozenKeys.has(JSON.stringify([
    shift.employeeId,shift.locationId,shift.startAt,
  ]));
  const locked=(shift:PlannerShift)=>shift.pinned || isFrozen(shift);
  function update(index:number,change:Partial<PlannerShift>) {
    if(locked(shifts[index]))return;
    onChange(shifts.map((s,i)=>i===index?{...s,...change}:s));
  }
  function time(index:number,side:"startAt"|"endAt",delta:number) {
    const shift=shifts[index];
    if(locked(shift))return;
    onChange(shifts.map((s,i)=>i===index?moveOliviaBoundary(shift,side,delta):s));
  }
  function setLocalTime(index:number,side:"startAt"|"endAt",value:string) {
    if(locked(shifts[index]))return;
    const zone=locations[shifts[index].locationId]??"UTC";
    try {
      const changed=setOliviaLocalBoundary(shifts[index],side,value,zone);
      setClockError("");
      onChange(shifts.map((s,i)=>i===index?changed:s));
    } catch {
      setClockError(t("invalidWallTime"));
    }
  }
  function add() {
    const employeeId=Object.keys(employees)[0],locationId=Object.keys(locations)[0];
    if(!employeeId || !locationId || shifts.length>=200)return;
    onChange([...shifts,addOliviaShift(week,shifts,employeeId,locationId,
      locations[locationId]??"UTC")]);
  }
  function setUnpaidBreak(index:number,enabled:boolean){
    const shift=shifts[index];
    if(locked(shift))return;
    onChange(shifts.map((s,i)=>i===index?setOliviaUnpaidBreak(shift,enabled):s));
  }
  return <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
    <h3 className="font-bold">{t("editTitle")}</h3>
    <p className="text-sm text-ink-muted">{t("editInstructions")}</p>
    {shifts.map((shift,index)=><div key={index}
      className="flex flex-col gap-2 rounded-xl bg-paper p-3">
      <div className="flex items-center justify-between gap-2">
        <strong>{t("shiftNumber",{number:index+1})}</strong>
        {isFrozen(shift) && <span className="text-sm text-ink-muted">{t("editPinned")}</span>}
        <button type="button" disabled={disabled || locked(shift)}
          className="min-h-12 px-3 underline disabled:opacity-50"
          onClick={()=>{if(!locked(shift))onChange(shifts.filter((_,i)=>i!==index));}}>
          {t("removeShift")}
        </button>
      </div>
      <label className="flex flex-col gap-1">{t("employee")}
        <select disabled={disabled || locked(shift)} value={shift.employeeId}
          className="min-h-12 rounded-lg border border-line bg-card px-3"
          onChange={e=>update(index,{employeeId:e.target.value})}>
          {Object.entries(employees).map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">{t("location")}
        <select disabled={disabled || locked(shift)} value={shift.locationId}
          className="min-h-12 rounded-lg border border-line bg-card px-3"
          onChange={e=>update(index,{locationId:e.target.value})}>
          {Object.keys(locations).map(id=><option key={id} value={id}>{names[id]||id}</option>)}
        </select>
      </label>
      {(["startAt","endAt"] as const).map(side=><div key={side} className="flex flex-col gap-1">
        <span>{t(side==="startAt"?"shiftStart":"shiftEnd")} ({locations[shift.locationId]||"UTC"})</span>
        <div className="flex items-center justify-between gap-2">
          <button type="button" disabled={disabled || locked(shift)}
            className="min-h-12 min-w-12 rounded-full border border-line disabled:opacity-50"
            aria-label={t("earlier")} onClick={()=>time(index,side,-1)}>−30</button>
          <span className="text-sm text-center">{local(shift[side],
            locations[shift.locationId]||"UTC",locale)}</span>
          <button type="button" disabled={disabled || locked(shift)}
            className="min-h-12 min-w-12 rounded-full border border-line disabled:opacity-50"
            aria-label={t("later")} onClick={()=>time(index,side,1)}>+30</button>
        </div>
        <input type="datetime-local" disabled={disabled || locked(shift)}
          aria-label={t(side==="startAt"?"shiftStart":"shiftEnd")}
          value={oliviaLocalBoundaryValue(shift[side],locations[shift.locationId]??"UTC")}
          onChange={e=>setLocalTime(index,side,e.target.value)}
          className="min-h-12 rounded-lg border border-line bg-card px-3"/>
      </div>)}
      <label className="flex items-center gap-3">
        <input type="checkbox" disabled={disabled || shift.pinned || shift.breaks.length>1 || shift.breaks.some(b=>b.paid)}
          checked={shift.breaks.length===1 && !shift.breaks[0].paid}
          onChange={e=>setUnpaidBreak(index,e.target.checked)}
          className="size-5"/>
        {t("unpaidBreak")}
      </label>
      {shift.breaks.map((brk,j)=><p key={j} className="text-sm">
         {t("breakWindow")} ({t(brk.paid?"breakPaid":"breakUnpaid")}): {" "}
         {local(brk.startAt,locations[shift.locationId]??"UTC",locale)}
         {" — "}{local(brk.endAt,locations[shift.locationId]??"UTC",locale)}
       </p>)}
       {shift.breaks.length>1 && <p className="text-sm">{t("existingBreaks")}</p>}
      <p className="text-sm text-ink-muted">{t("paidMinutes")}: {shift.paidMinutes}</p>
    </div>)}
    {clockError && <p role="alert" className="text-sm text-warn">{clockError}</p>}
    <button type="button" onClick={add}
      disabled={disabled || !Object.keys(employees).length || !Object.keys(locations).length ||
        shifts.length>=200}
      className="min-h-12 rounded-full border border-line px-3 font-semibold disabled:opacity-50">
      {t("addShift")}
    </button>
  </section>;
}
