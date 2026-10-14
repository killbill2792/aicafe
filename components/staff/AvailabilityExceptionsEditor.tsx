"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { saveStaffAvailabilityBatch } from "@/lib/actions/schedulingFoundation";
import { type SchedulingRow, type SchedulingLocation,
  schedulingFieldClass as field, schedulingButtonClass as secondary,
  schedulingPrimaryClass as primary } from "./AvailabilityEditor";

type ExceptionType = "unavailable" | "approved_leave" | "replace_day" | "add_available" | "hours_cap";
type ExceptionDraft = {
  id?: string; exception_type: ExceptionType;
  start_local: string; end_local: string; overnight: boolean;
  max_minutes: string;
  source: "owner_direct" | "worker_reported_by_owner";
  confirmation: "owner_confirmed" | "unconfirmed";
};
const fromRow = (r: SchedulingRow): ExceptionDraft => ({
  id:r.id, exception_type: r.exception_type as ExceptionType,
  start_local: String(r.start_local ?? ""), end_local: String(r.end_local ?? ""),
  overnight: r.overnight===true, max_minutes: r.max_minutes == null ? "" : String(r.max_minutes),
  source: r.source === "worker_reported_by_owner" ? "worker_reported_by_owner" : "owner_direct",
  confirmation: r.confirmation === "owner_confirmed" ? "owner_confirmed" : "unconfirmed",
});

export default function AvailabilityExceptionsEditor({ employeeId, rows, locations, today }: {
  employeeId: string; rows: SchedulingRow[]; locations: SchedulingLocation[]; today: string;
}) {
  const t = useTranslations("SchedulingAvailability"), router = useRouter();
  const [date,setDate] = useState(today);
  const [locationId,setLocationId] = useState("");
  const [draftOverride,setDraftOverride] = useState<ExceptionDraft[] | null>(null);
  const [dirty,setDirty] = useState(false);
  const [pending,startTransition] = useTransition();
  const [status,setStatus] = useState<"idle"|"saved"|"error"|"conflict">("idle");
  const key = useRef<string | null>(null);
  const scoped = useMemo(() => rows.filter(r => r.employee_id===employeeId &&
    r.local_date===date && (r.location_id??null)===(locationId||null)
  ),[rows,employeeId,date,locationId]);
  const draft = draftOverride ?? scoped.map(fromRow);
  function touch(next: ExceptionDraft[]) {
    setDraftOverride(next); setDirty(true); setStatus("idle"); key.current=null;
  }
  function changeScope(fn: (value: string) => void, value: string) {
    if (dirty && !window.confirm(t("discardEdits"))) return;
    setDraftOverride(null); setDirty(false); setStatus("idle"); key.current=null; fn(value);
  }
  function update(i:number, patch:Partial<ExceptionDraft>) {
    touch(draft.map((r,j) => j===i ? {...r,...patch} : r));
  }
  function save() {
    key.current ??= crypto.randomUUID();
    const desired = draft.map(r => ({
      ...(r.id ? {id:r.id} : {}),
      data: {
        employee_id:employeeId, location_id:locationId||null, local_date:date,
        exception_type:r.exception_type, overnight:r.overnight,
        source:r.source, confirmation:r.confirmation,
        ...(r.exception_type==="hours_cap"
          ? {max_minutes:Number(r.max_minutes),start_local:null,end_local:null}
          : r.exception_type==="approved_leave" ||
            (r.exception_type==="unavailable" && (!r.start_local || !r.end_local))
          ? {start_local:null,end_local:null,max_minutes:null,overnight:false}
          : {start_local:r.start_local,end_local:r.end_local,max_minutes:null}),
      },
    }));
    startTransition(async () => {
      const result = await saveStaffAvailabilityBatch({
        kind:"availability_exception",employeeId,locationId:locationId||null,
        scope:{local_date:date},expected:scoped.map(r=>({id:r.id,revision:r.revision})),
        desired,requestKey:key.current,
      });
      if (!result.ok) {setStatus(result.error==="conflict"?"conflict":"error");return;}
      key.current=null;setDraftOverride(null);setDirty(false);setStatus("saved");router.refresh();
    });
  }
  const exceptionTypes:ExceptionType[]=["unavailable","approved_leave","replace_day","add_available","hours_cap"];
  return <section aria-label={t("dateExceptions")} className="flex flex-col gap-3 rounded-xl bg-white p-3">
    <h4 className="text-base font-bold">{t("dateExceptions")}</h4>
    <p className="text-sm text-ink-muted">{t("exceptionExplainer")}</p>
    <label className="flex flex-col gap-1 text-sm font-semibold">{t("date")}
      <input type="date" className={field} value={date}
        onChange={e=>changeScope(setDate,e.target.value)}/>
    </label>
    <label className="flex flex-col gap-1 text-sm font-semibold">{t("location")}
      <select className={field} value={locationId}
        onChange={e=>changeScope(setLocationId,e.target.value)}>
        <option value="">{t("allLocations")}</option>
        {locations.map(l=><option value={l.id} key={l.id}>{l.name}</option>)}
      </select>
    </label>
    {draft.length===0 && <p className="text-sm text-ink-muted">{t("noExceptions")}</p>}
    {draft.map((r,i)=><div key={r.id??`new-${i}`} className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <label className="flex flex-col gap-1 text-sm">{t("exceptionType")}
        <select className={field} value={r.exception_type}
          onChange={e=>update(i,{exception_type:e.target.value as ExceptionType})}>
          {exceptionTypes.map(v=><option key={v} value={v}>{t(v)}</option>)}
        </select>
      </label>
      {r.exception_type==="hours_cap" ? <label className="flex flex-col gap-1 text-sm">
        {t("maxMinutes")}
        <input type="number" min="0" max="1440" className={field}
          value={r.max_minutes} onChange={e=>update(i,{max_minutes:e.target.value})}/>
      </label> : r.exception_type!=="approved_leave" && <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">{t("start")}
          <input type="time" className={field} value={r.start_local}
            onChange={e=>update(i,{start_local:e.target.value})}/>
        </label>
        <label className="flex flex-col gap-1 text-sm">{t("end")}
          <input type="time" className={field} value={r.end_local}
            onChange={e=>update(i,{end_local:e.target.value})}/>
        </label>
      </div>}
      {r.exception_type!=="hours_cap" && r.exception_type!=="approved_leave" &&
       <label className="flex min-h-12 items-center gap-2 text-sm">
         <input type="checkbox" checked={r.overnight}
           onChange={e=>update(i,{overnight:e.target.checked})}/>{t("overnight")}
       </label>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">{t("source")}
          <select className={field} value={r.source}
            onChange={e=>update(i,{source:e.target.value as ExceptionDraft["source"]})}>
            <option value="owner_direct">{t("ownerDirect")}</option>
            <option value="worker_reported_by_owner">{t("workerReported")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">{t("confirmation")}
          <select className={field} value={r.confirmation}
            onChange={e=>update(i,{confirmation:e.target.value as ExceptionDraft["confirmation"]})}>
            <option value="unconfirmed">{t("unconfirmed")}</option>
            <option value="owner_confirmed">{t("ownerConfirmed")}</option>
          </select>
        </label>
      </div>
      <button type="button" className={secondary}
        onClick={()=>touch(draft.filter((_,j)=>i!==j))}>{t("remove")}</button>
    </div>)}
    <button type="button" className={secondary}
      onClick={()=>touch([...draft,{exception_type:"unavailable",start_local:"",
        end_local:"",overnight:false,max_minutes:"",
        source:"owner_direct",confirmation:"unconfirmed"}])}>{t("addException")}</button>
    <p className="text-sm text-ink-muted">{t("exceptionPrecedence")}</p>
    {dirty && <p role="status" className="text-sm text-warn">{t("unsaved")}</p>}
    {status==="saved" && <p role="status" className="text-sm text-good">{t("saved")}</p>}
    {status==="conflict" && <p role="alert" className="text-sm text-warn">{t("conflict")}</p>}
    {status==="error" && <p role="alert" className="text-sm text-warn">{t("saveFailed")}</p>}
    <button type="button" className={primary} onClick={save} disabled={pending||!dirty}>
      {pending?t("saving"):t("saveExceptions")}
    </button>
  </section>;
}
