"use client";

import { useRef, useState, useTransition } from "react";
import { stableCreateRequestKey, type PendingCreate } from "@/lib/scheduling/idempotencyClient";
import { minutesToHourInput, hourInputToMinutes } from "@/lib/scheduling/hourInput";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { saveSchedulingFoundationRecord } from "@/lib/actions/schedulingFoundation";
import { type SchedulingRow, schedulingFieldClass as field,
  schedulingPrimaryClass as primary, schedulingButtonClass as secondary } from "./AvailabilityEditor";

const sourceOptions = ["owner_direct","worker_reported_by_owner"] as const;
const confirmedOptions = ["unconfirmed","owner_confirmed"] as const;

export default function SchedulingPreferencesEditor({ employeeId, preferences, windows, today }: {
  employeeId: string; preferences: SchedulingRow[]; windows: SchedulingRow[]; today: string;
}) {
  const t = useTranslations("SchedulingAvailability"), router = useRouter();
  const active = preferences.filter(r=>r.employee_id===employeeId);
  const prefWindows = windows.filter(r=>r.employee_id===employeeId);
  const [selected,setSelected] = useState<string>(active[0]?.id??"");
  const [lastSaved,setLastSaved]=useState<{id:string;revision:number}|null>(null);
  const selectedRow = active.find(r=>r.id===selected);
  const selectedVersion = selectedRow ??
    (lastSaved?.id===selected ? lastSaved : null);
  const [from,setFrom] = useState(String(selectedRow?.effective_from??today));
  const [to,setTo] = useState(String(selectedRow?.effective_to??""));
  const [min,setMin] = useState(minutesToHourInput(Number(selectedRow?.min_weekly_minutes??0)));
  const [desired,setDesired] = useState(minutesToHourInput(selectedRow?.desired_weekly_minutes as number | null | undefined));
  const [max,setMax] = useState(minutesToHourInput(selectedRow?.max_weekly_minutes as number | null | undefined));
  const [daily,setDaily] = useState(minutesToHourInput(selectedRow?.max_daily_minutes as number | null | undefined));
  const [hardUnavailableDays,setHardUnavailableDays] = useState<number[]>(
    Array.isArray(selectedRow?.unavailable_weekdays)
      ? (selectedRow.unavailable_weekdays as number[]) : [],
  );
  const [source,setSource] = useState<"owner_direct"|"worker_reported_by_owner">(
    selectedRow?.source==="worker_reported_by_owner"?"worker_reported_by_owner":"owner_direct");
  const [confirmation,setConfirmation] = useState<"unconfirmed"|"owner_confirmed">(
    selectedRow?.confirmation==="owner_confirmed"?"owner_confirmed":"unconfirmed");
  const [day,setDay] = useState("1"),[start,setStart] = useState("09:00"),[end,setEnd] = useState("17:00");
  const [overnight,setOvernight] = useState(false);
  const [preference,setPreference] = useState<"prefer"|"avoid">("prefer");
  const [strength,setStrength] = useState<"soft"|"hard">("soft");
  const [error,setError] = useState(""),[saved,setSaved] = useState(false);
  const [pending,run] = useTransition();
  const preferenceRetry=useRef<PendingCreate>(null), windowRetry=useRef<PendingCreate>(null);

  function selectPreference(id:string) {
    setSelected(id);setLastSaved(null); const r=active.find(row=>row.id===id);
    setFrom(String(r?.effective_from??today));setTo(String(r?.effective_to??""));
    setMin(minutesToHourInput(Number(r?.min_weekly_minutes??0)));setDesired(minutesToHourInput(r?.desired_weekly_minutes as number | null | undefined));
    setMax(minutesToHourInput(r?.max_weekly_minutes as number | null | undefined));setDaily(minutesToHourInput(r?.max_daily_minutes as number | null | undefined));
    setHardUnavailableDays(Array.isArray(r?.unavailable_weekdays)
      ? r.unavailable_weekdays as number[] : []);
    setSource(r?.source==="worker_reported_by_owner"?"worker_reported_by_owner":"owner_direct");
    setConfirmation(r?.confirmation==="owner_confirmed"?"owner_confirmed":"unconfirmed");
    setSaved(false);setError("");
  }
  function savePreference() {
    let a:number, b:number|null, c:number|null, dailyMinutes:number|null;
    try {
      a=hourInputToMinutes(min,10080,true)!;
      b=hourInputToMinutes(desired,10080);
      c=hourInputToMinutes(max,10080);
      dailyMinutes=hourInputToMinutes(daily,1440);
      if (!from || (to && to<from) ||
          (b!==null && b<a) || (c!==null && (c<a || (b!==null && b>c)))) {
        setError(t("invalidLimits"));return;
      }
    } catch {
      setError(t("invalidLimits"));return;
    }
    const payload={employee_id:employeeId,effective_from:from,effective_to:to||null,
      min_weekly_minutes:a,desired_weekly_minutes:b,max_weekly_minutes:c,
      max_daily_minutes:dailyMinutes,
      unavailable_weekdays:[...hardUnavailableDays].sort((a,b)=>a-b),source,confirmation};
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"preferences",action:selectedVersion?"update":"create",
        ...(selectedVersion?{id:selectedVersion.id,expectedRevision:selectedVersion.revision}:
          {requestKey:stableCreateRequestKey(preferenceRetry,payload)}),
        data:payload,
      });
      if(!result.ok){setError(t("saveFailed"));return;}
      preferenceRetry.current=null;setSelected(result.id);
      setLastSaved({id:result.id,revision:result.revision});
      setError("");setSaved(true);router.refresh();
    });
  }
  function saveWindow() {
    const payload={employee_id:employeeId,day_of_week:Number(day),start_local:start,end_local:end,
      overnight,preference,strength,effective_from:from,effective_to:to||null,source,confirmation};
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"preference_window",action:"create",requestKey:stableCreateRequestKey(windowRetry,payload),
        data:payload,
      });
      if(!result.ok){setError(t("saveFailed"));return;}
      windowRetry.current=null;setError("");setSaved(true);router.refresh();
    });
  }
  function removeWindow(row:SchedulingRow){
    if(!window.confirm(t("confirmRemove")))return;
    run(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"preference_window",action:"delete",id:row.id,expectedRevision:row.revision,
      });
      if(!result.ok){setError(t("conflict"));return;}setError("");router.refresh();
    });
  }
  const days=[t("sun"),t("mon"),t("tue"),t("wed"),t("thu"),t("fri"),t("sat")];
  return <section className="flex flex-col gap-3 rounded-xl bg-white p-3">
    <h4 className="text-base font-bold">{t("hourLimitsAndPreferences")}</h4>
    <label className="flex flex-col gap-1 text-sm font-semibold">{t("existingPeriods")}
      <select className={field} value={selected} onChange={e=>selectPreference(e.target.value)}>
        <option value="">{t("newPeriod")}</option>
        {active.map(r=><option key={r.id} value={r.id}>{String(r.effective_from)} — {String(r.effective_to??t("ongoing"))}</option>)}
        {lastSaved && !active.some(r=>r.id===lastSaved.id) &&
          <option value={lastSaved.id}>{t("saved")}</option>}
      </select>
    </label>
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-sm">{t("effectiveFrom")}
        <input className={field} type="date" value={from} onChange={e=>setFrom(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("effectiveTo")}
        <input className={field} type="date" value={to} onChange={e=>setTo(e.target.value)}/>
      </label>
    </div>
    {([
      [t("minimumWeekly"),min,setMin],[t("desiredWeekly"),desired,setDesired],
      [t("maximumWeekly"),max,setMax],[t("maximumDaily"),daily,setDaily],
    ] as [string,string,(x:string)=>void][]).map(([label,value,fn])=>
      <label key={label} className="flex flex-col gap-1 text-sm">{label} ({t("hoursMinutes")})
        <input className={field} type="text" inputMode="numeric" placeholder="8:00"
          value={value} onChange={e=>fn(e.target.value)}/>
      </label>)}
    <fieldset className="rounded-xl border border-line p-3">
      <legend className="font-semibold">{t("hardUnavailableDays")}</legend>
      <p className="text-sm text-ink-muted">{t("hardUnavailableDaysHelp")}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0,1,2,3,4,5,6].map(d=><label key={d}
          className="flex min-h-12 items-center gap-2 rounded-xl border border-line px-2 text-sm">
          <input type="checkbox" checked={hardUnavailableDays.includes(d)}
            onChange={e=>setHardUnavailableDays(old=>e.target.checked
              ? [...old,d] : old.filter(x=>x!==d))}/>
          {t(["sun","mon","tue","wed","thu","fri","sat"][d])}
        </label>)}
      </div>
    </fieldset>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">{t("source")}
        <select className={field} value={source} onChange={e=>setSource(e.target.value as typeof source)}>
          {sourceOptions.map(k=><option key={k} value={k}>{t(k==="owner_direct"?"ownerDirect":"workerReported")}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("confirmation")}
        <select className={field} value={confirmation}
          onChange={e=>setConfirmation(e.target.value as typeof confirmation)}>
          {confirmedOptions.map(k=><option key={k} value={k}>{t(k==="unconfirmed"?"unconfirmed":"ownerConfirmed")}</option>)}
        </select>
      </label>
    </div>
    <button className={primary} disabled={pending} type="button" onClick={savePreference}>
      {t("saveLimits")}
    </button>
    <h5 className="text-base font-semibold">{t("preferredAvoidedHours")}</h5>
    {prefWindows.map(r=><div key={r.id} className="flex items-center justify-between gap-2 rounded-xl border border-line p-2">
      <p className="text-sm">{days[Number(r.day_of_week)]} {String(r.start_local)}–{String(r.end_local)}
        {" · "}{r.preference==="avoid"?t("avoid"):t("prefer")} {" · "}
        {r.strength==="hard"?t("hard"):t("soft")} {" · "}
        {r.confirmation==="owner_confirmed"?t("ownerConfirmed"):t("unconfirmed")}</p>
      <button className={secondary} type="button" disabled={pending} onClick={()=>removeWindow(r)}>{t("remove")}</button>
    </div>)}
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-sm">{t("day")}
        <select className={field} value={day} onChange={e=>setDay(e.target.value)}>
          {days.map((label,i)=><option key={i} value={i}>{label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("preference")}
        <select className={field} value={preference} onChange={e=>{setPreference(e.target.value as typeof preference);if(strength==="hard")setStrength("soft");}}>
          <option value="prefer">{t("prefer")}</option><option value="avoid">{t("avoid")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("start")}
        <input className={field} type="time" value={start} onChange={e=>setStart(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("end")}
        <input className={field} type="time" value={end} onChange={e=>setEnd(e.target.value)}/>
      </label>
      <label className="flex flex-col gap-1 text-sm">{t("strength")}
        <select className={field} value={strength} onChange={e=>setStrength(e.target.value as typeof strength)}>
          <option value="soft">{t("soft")}</option>
          {preference==="avoid"&&<option value="hard">{t("hard")}</option>}
        </select>
      </label>
      <label className="flex min-h-12 items-center gap-2 text-sm">
        <input type="checkbox" checked={overnight} onChange={e=>setOvernight(e.target.checked)}/>
        {t("overnight")}
      </label>
    </div>
    <button type="button" className={secondary} disabled={pending||!from} onClick={saveWindow}>{t("addPreference")}</button>
    {error && <p role="alert" className="text-sm text-warn">{error}</p>}
    {saved && <p role="status" className="text-sm text-good">{t("saved")}</p>}
  </section>;
}
