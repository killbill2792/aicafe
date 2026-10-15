"use client";

import { useRef, useState, useTransition } from "react";
import { stableCreateRequestKey, type PendingCreate } from "@/lib/scheduling/idempotencyClient";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { getSchedulingFoundationRecords, saveSchedulingFoundationRecord } from "@/lib/actions/schedulingFoundation";
import { findEquivalentCoverage } from "@/lib/scheduling/coverageIdentity";
import { type SchedulingRow, type SchedulingLocation,
 schedulingFieldClass as field, schedulingButtonClass as secondary,
 schedulingPrimaryClass as primary } from "./AvailabilityEditor";

export default function StaffCoverageEditor({ rows, locations, qualifications, today, businessTimezone }: {
  rows: SchedulingRow[]; locations: SchedulingLocation[];
  qualifications: SchedulingRow[]; today: string; businessTimezone:string;
}) {
  const t=useTranslations("SchedulingAvailability"),router=useRouter();
  const [selected,setSelected]=useState("");
  const [savedRecord,setSavedRecord]=useState<{id:string;revision:number}|null>(null);
  const [conflicted,setConflicted]=useState(false);
  const [locationId,setLocationId]=useState(locations[0]?.id??"");
  const [day,setDay]=useState("1"),[specificDate,setSpecificDate]=useState("");
  const [from,setFrom]=useState(locations[0]?.todayLocal??today),[to,setTo]=useState("");
  const [fromEdited,setFromEdited]=useState(false);
  const [start,setStart]=useState("08:00"),[end,setEnd]=useState("16:00");
  const [overnight,setOvernight]=useState(false),[count,setCount]=useState("1");
  const [code,setCode]=useState(""),[overlap,setOverlap]=useState("0");
  const [priority,setPriority]=useState<"required"|"advisory">("required");
  const [confirmation,setConfirmation]=useState<"unconfirmed"|"owner_confirmed">("unconfirmed");
  const [source,setSource]=useState<"owner_direct"|"worker_reported_by_owner">("owner_direct");
  const [pending,run]=useTransition(),[error,setError]=useState(""),[saved,setSaved]=useState(false);
  const retry=useRef<PendingCreate>(null);
  const names=[t("sun"),t("mon"),t("tue"),t("wed"),t("thu"),t("fri"),t("sat")];
  const location=locations.find(l=>l.id===locationId);
  function select(id:string){
    setConflicted(false);setSelected(id);const r=rows.find(v=>v.id===id);
    setSavedRecord(r ? {id:r.id,revision:r.revision} : null);
    // Saved effective dates are never pristine proposed defaults.
    setFromEdited(Boolean(r));
    if (!r) return;
    setLocationId(String(r.location_id));setDay(String(r.day_of_week??1));
    setSpecificDate(String(r.local_date??""));setFrom(String(r.effective_from??today));
    setTo(String(r.effective_to??""));setStart(String(r.start_local));setEnd(String(r.end_local));
    setOvernight(r.overnight===true);setCount(String(r.min_headcount));setOverlap(String(r.min_overlap_minutes??0));
    setCode(String(r.qualification_code??""));setPriority(r.priority==="advisory"?"advisory":"required");
    setSource(r.source==="worker_reported_by_owner"?"worker_reported_by_owner":"owner_direct");
    setConfirmation(r.confirmation==="owner_confirmed"?"owner_confirmed":"unconfirmed");setSaved(false);setError("");
  }
  function changeLocation(value:string) {
    setLocationId(value);
    if (!fromEdited) setFrom(locations.find(l=>l.id===value)?.todayLocal??today);
  }
  function coveragePayload(){
    return {location_id:locationId,day_of_week:specificDate?null:Number(day),
      local_date:specificDate||null,effective_from:specificDate?null:from,
      effective_to:specificDate?null:(to||null),start_local:start,end_local:end,overnight,
      min_headcount:Number(count),qualification_code:code||null,
      min_overlap_minutes:Number(overlap),priority,source,confirmation};
  }
  function save(){
    if(conflicted){setError(t("conflict"));return;}
    if(!locationId){setError(t("chooseLocation"));return;}
    const old=savedRecord?.id===selected ? savedRecord : null;
    const payload=coveragePayload();
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"coverage",action:old?"update":"create",
        ...(old?{id:old.id,expectedRevision:old.revision}:
          {requestKey:stableCreateRequestKey(retry,payload)}),
        data:payload,
      });
      if(!result.ok){
        if(result.error==="conflict_or_missing"){setConflicted(true);router.refresh();}
        setError(t(result.error==="conflict_or_missing"?"conflict":"saveFailed"));return;
      }
      retry.current=null;setSavedRecord({id:result.id,revision:result.revision});
      setSelected(result.id);setError("");setSaved(true);router.refresh();
    });
  }
  function remove(r:SchedulingRow){
    if(!window.confirm(t("confirmRemove")))return;
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"coverage",action:"delete",id:r.id,expectedRevision:r.revision,
      });
      if(!result.ok){setError(t("conflict"));return;}
      setSelected("");setError("");router.refresh();
    });
  }
  return <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
    <h3 className="text-[17px] font-bold">{t("staffingNeeds")}</h3>
    <p className="text-[17px] text-ink-muted">{t("coverageExplainer")}</p>
    {conflicted && <button type="button" className={secondary} disabled={pending} onClick={()=>run(async()=>{
      // Fetch committed rows instead of treating router.refresh() as finished.
      // If a distinct-key create collided, explicitly adopt that exact demand
      // for revision-checked editing rather than retrying a duplicate insert.
      const result=await getSchedulingFoundationRecords();
      if(!result.ok){setError(t("saveFailed"));return;}
      const current=result.records.coverage as SchedulingRow[];
      const fresh=selected ? current.find(r=>r.id===selected)
        : findEquivalentCoverage(current,coveragePayload());
      setSavedRecord(fresh?{id:fresh.id,revision:fresh.revision}:null);
      setSelected(fresh?.id??"");
      setConflicted(false);setError("");retry.current=null;router.refresh();
    })}>{t("applyAfterConflict")}</button>}
    <fieldset disabled={pending || conflicted} aria-busy={pending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
    {locations.length===0 && <p role="status" className="text-[17px] text-warn">{t("noLocations")}</p>}
    {rows.length===0&&<p className="text-[17px] text-ink-muted">{t("noCoverage")}</p>}
    {rows.map(r=><div key={r.id} className="flex items-center justify-between gap-2 rounded-xl border border-line p-3">
      <p className="min-w-0 text-[17px]">{locations.find(l=>l.id===r.location_id)?.name??t("location")}
        {" · "}{r.local_date?String(r.local_date):names[Number(r.day_of_week)]}
        {" · "}{String(r.start_local)}–{String(r.end_local)}
        {" · "}{String(r.min_headcount)} {t("people")}
        {" · "}{r.confirmation==="owner_confirmed"?t("ownerConfirmed"):t("unconfirmed")}</p>
      <div className="flex shrink-0 gap-1">
        <button className={secondary} type="button" onClick={()=>select(r.id)}>{t("edit")}</button>
        <button className={secondary} type="button" disabled={pending} onClick={()=>remove(r)}>{t("remove")}</button>
      </div>
    </div>)}
    <label className="flex flex-col gap-1 text-[17px]">{t("existingRecords")}
      <select className={field} value={selected} onChange={e=>select(e.target.value)}>
        <option value="">{t("newRequirement")}</option>
        {savedRecord && !rows.some(r=>r.id===savedRecord.id) &&
          <option value={savedRecord.id}>{t("saved")}</option>}
        {rows.map(r=><option key={r.id} value={r.id}>
          {locations.find(l=>l.id===r.location_id)?.name} · {String(r.start_local)}–{String(r.end_local)}
        </option>)}
      </select>
    </label>
    <label className="flex flex-col gap-1 text-[17px]">{t("location")}
      <select className={field} value={locationId} onChange={e=>changeLocation(e.target.value)}>
        {locations.map(l=><option value={l.id} key={l.id}>{l.name}</option>)}
      </select>
    </label>
    <p className="text-[17px] text-ink-muted">{t("timezone")}: {location?.timezone??businessTimezone}
      {location?.timezone? "":` (${t("inheritedTimezone")})`}</p>
    <label className="flex flex-col gap-1 text-[17px]">{t("specificDate")}
      <input className={field} type="date" value={specificDate} onChange={e=>setSpecificDate(e.target.value)}/>
    </label>
    {!specificDate&&<div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-[17px]">{t("day")}
        <select className={field} value={day} onChange={e=>setDay(e.target.value)}>
          {names.map((n,i)=><option value={i} key={i}>{n}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("effectiveFrom")}
        <input className={field} type="date" value={from} onChange={e=>{setFromEdited(true);setFrom(e.target.value);}}/>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("effectiveTo")}
        <input className={field} type="date" value={to} onChange={e=>setTo(e.target.value)}/>
      </label>
    </div>}
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-[17px]">{t("start")}
        <input className={field} type="time" value={start} onChange={e=>setStart(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("end")}
        <input className={field} type="time" value={end} onChange={e=>setEnd(e.target.value)}/>
      </label>
      <label className="flex min-h-12 items-center gap-2 text-[17px]">
        <input type="checkbox" checked={overnight} onChange={e=>setOvernight(e.target.checked)}/>{t("overnight")}
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("minimumHeadcount")}
        <input className={field} type="number" min="0" max="50" value={count} onChange={e=>setCount(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("qualification")}
        <select className={field} value={code} onChange={e=>setCode(e.target.value)}>
          <option value="">{t("anyQualification")}</option>
          {qualifications.filter(r=>r.active!==false).map(r=><option key={r.id} value={String(r.code)}>{String(r.display_name)}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("minOverlapMinutes")}
        <input className={field} type="number" min="0" max="1440" value={overlap} onChange={e=>setOverlap(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("priority")}
        <select className={field} value={priority} onChange={e=>setPriority(e.target.value as typeof priority)}>
          <option value="required">{t("required")}</option>
          <option value="advisory">{t("advisory")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("source")}
        <select className={field} value={source} onChange={e=>setSource(e.target.value as typeof source)}>
          <option value="owner_direct">{t("ownerDirect")}</option>
          <option value="worker_reported_by_owner">{t("workerReported")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("confirmation")}
        <select className={field} value={confirmation} onChange={e=>setConfirmation(e.target.value as typeof confirmation)}>
          <option value="unconfirmed">{t("unconfirmed")}</option>
          <option value="owner_confirmed">{t("ownerConfirmed")}</option>
        </select>
      </label>
    </div>
    <button className={primary} type="button" onClick={save} disabled={pending||locations.length===0}>
      {t("saveRequirement")}
    </button>
    {error&&<p role="alert" className="text-[17px] text-warn">{error}</p>}
    {saved&&<p role="status" className="text-[17px] text-good">{t("saved")}</p>}
    </fieldset>
  </section>;
}
