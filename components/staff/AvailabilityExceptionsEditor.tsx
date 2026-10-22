"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { getSchedulingFoundationRecords, saveStaffAvailabilityBatch } from "@/lib/actions/schedulingFoundation";
import { reconcileDeletedDraftIds } from "@/lib/scheduling/reconcileDraft";
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
  const [dateEdited,setDateEdited] = useState(false);
  const [locationId,setLocationId] = useState("");
  const [draftOverride,setDraftOverride] = useState<ExceptionDraft[] | null>(null);
  const [dirty,setDirty] = useState(false);
  const [pending,startTransition] = useTransition();
  const [status,setStatus] = useState<"idle"|"saved"|"error"|"conflict">("idle");
  const key = useRef<string | null>(null);
  const draftManifest = useRef<{id:string;revision:number}[] | null>(null);
  const [reapplyReady,setReapplyReady] = useState(false);
  const [rebasedScoped,setRebasedScoped] = useState<SchedulingRow[] | null>(null);
  const scoped = useMemo(() => rows.filter(r => r.employee_id===employeeId &&
    r.local_date===date && (r.location_id??null)===(locationId||null)
  ),[rows,employeeId,date,locationId]);
  const latestScoped = status==="conflict" && reapplyReady && rebasedScoped ? rebasedScoped : scoped;
  const draft = draftOverride ?? scoped.map(fromRow);
  function touch(next: ExceptionDraft[]) {
    draftManifest.current ??= scoped.map(r=>({id:r.id,revision:r.revision}));
    // Never dismiss a CAS conflict merely because the owner edits the
    // preserved local draft. Explicit reapplication must use fresh revisions.
    setDraftOverride(next); setDirty(true);
    setStatus(current=>current==="conflict"?"conflict":"idle"); key.current=null;
  }
  function changeScope(fn: (value: string) => void, value: string) {
    if (dirty && !window.confirm(t("discardEdits"))) return;
    setDraftOverride(null); draftManifest.current=null; setRebasedScoped(null); setDirty(false); setStatus("idle"); setReapplyReady(false); key.current=null; fn(value);
  }
  function switchLocation(value:string) {
    if (dirty && !window.confirm(t("discardEdits"))) return;
    setDraftOverride(null);draftManifest.current=null;setRebasedScoped(null);setDirty(false);setStatus("idle");setReapplyReady(false);key.current=null;
    setLocationId(value);
    if (!dateEdited) setDate(locations.find(l=>l.id===value)?.todayLocal??today);
  }
  function update(i:number, patch:Partial<ExceptionDraft>) {
    touch(draft.map((r,j) => j===i ? {...r,...patch} : r));
  }
  function save() {
    if (status==="conflict" && !reapplyReady) {router.refresh();return;}
    if (status==="conflict" && !window.confirm(t("applyAfterConflict"))) return;
    if (latestScoped.some((row) => !draft.some((d) => d.id===row.id)) &&
        !window.confirm(t("confirmRemove"))) return;
    if (draft.some((r) => r.exception_type==="hours_cap" &&
        (r.max_minutes.trim()==="" || !Number.isInteger(Number(r.max_minutes)) ||
         Number(r.max_minutes)<0 || Number(r.max_minutes)>1440))) {
      setStatus("error"); return;
    }
    if (draft.some(r =>
      (r.exception_type==="unavailable" &&
        Boolean(r.start_local) !== Boolean(r.end_local)) ||
      ((r.exception_type==="replace_day" || r.exception_type==="add_available") &&
        (!r.start_local || !r.end_local)))) {
      setStatus("error"); return;
    }
    key.current ??= crypto.randomUUID();
    const desired = reconcileDeletedDraftIds(draft,latestScoped).map(r => ({
      ...(r.id ? {id:r.id} : {}),
      data: {
        employee_id:employeeId, location_id:locationId||null, local_date:date,
        exception_type:r.exception_type, overnight:r.overnight,
        source:r.source, confirmation:r.confirmation,
        ...(r.exception_type==="hours_cap"
          ? {max_minutes:Number(r.max_minutes),start_local:null,end_local:null}
          : r.exception_type==="approved_leave" ||
            (r.exception_type==="unavailable" && !r.start_local && !r.end_local)
          ? {start_local:null,end_local:null,max_minutes:null,overnight:false}
          : {start_local:r.start_local,end_local:r.end_local,max_minutes:null}),
      },
    }));
    startTransition(async () => {
      const result = await saveStaffAvailabilityBatch({
        kind:"availability_exception",employeeId,locationId:locationId||null,
        scope:{local_date:date},expected:status==="conflict" && reapplyReady
          ? latestScoped.map(r=>({id:r.id,revision:r.revision}))
          : draftManifest.current ?? scoped.map(r=>({id:r.id,revision:r.revision})),
        desired,requestKey:key.current,
      });
      if (!result.ok) {
        if (result.error==="conflict") {key.current=null;setReapplyReady(false);setRebasedScoped(null);router.refresh();}
        setStatus(result.error==="conflict"?"conflict":"error");return;
      }
      key.current=null;draftManifest.current=null;setReapplyReady(false);setRebasedScoped(null);setDraftOverride(null);setDirty(false);setStatus("saved");router.refresh();
    });
  }
  const exceptionTypes:ExceptionType[]=["unavailable","approved_leave","replace_day","add_available","hours_cap"];
  return <section aria-label={t("dateExceptions")} className="flex flex-col gap-3 rounded-xl bg-surface p-3">
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
    <h4 className="text-[17px] font-bold">{t("dateExceptions")}</h4>
    {status==="conflict" && !reapplyReady && <button type="button" className={secondary}
      onClick={()=>startTransition(async()=>{
        // A pending router refresh does not guarantee fresh props. Read the
        // currently authorized database records before allowing reapply.
        const result=await getSchedulingFoundationRecords();
        if(!result.ok){return;} // Keep the original conflict gate and draft; reapply may be retried.
        const current=(result.records.availability_exception as SchedulingRow[]).filter(r=>
          r.employee_id===employeeId && r.local_date===date &&
          (r.location_id??null)===(locationId||null));
        setRebasedScoped(current);
        draftManifest.current=current.map(r=>({id:r.id,revision:r.revision}));
        setReapplyReady(true);router.refresh();
      })}>{t("applyAfterConflict")}</button>}
    <p className="text-[17px] text-ink-muted">{t("exceptionExplainer")}</p>
    <label className="flex flex-col gap-1 text-[17px] font-semibold">{t("date")}
      <input type="date" className={field} value={date}
        onChange={e=>{setDateEdited(true);changeScope(setDate,e.target.value);}}/>
    </label>
    <label className="flex flex-col gap-1 text-[17px] font-semibold">{t("location")}
      <select className={field} value={locationId}
        onChange={e=>switchLocation(e.target.value)}>
        <option value="">{t("allLocations")}</option>
        {locations.map(l=><option value={l.id} key={l.id}>{l.name}</option>)}
      </select>
    </label>
    {draft.length===0 && <p className="text-[17px] text-ink-muted">{t("noExceptions")}</p>}
    {draft.map((r,i)=><div key={r.id??`new-${i}`} className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <label className="flex flex-col gap-1 text-[17px]">{t("exceptionType")}
        <select className={field} value={r.exception_type}
          onChange={e=>update(i,{exception_type:e.target.value as ExceptionType})}>
          {exceptionTypes.map(v=><option key={v} value={v}>{t(v)}</option>)}
        </select>
      </label>
      {r.exception_type==="unavailable" && <label className="flex min-h-12 items-center gap-2 text-[17px]">
        <input type="checkbox" checked={!r.start_local && !r.end_local}
          onChange={e=>update(i,e.target.checked
            ? {start_local:"",end_local:"",overnight:false}
            : {start_local:"09:00",end_local:"17:00",overnight:false})}/>
        {t("fullDay")}
      </label>}
      {r.exception_type==="hours_cap" ? <label className="flex flex-col gap-1 text-[17px]">
        {t("maxMinutes")}
        <input type="number" min="0" max="1440" className={field}
          value={r.max_minutes} onChange={e=>update(i,{max_minutes:e.target.value})}/>
      </label> : r.exception_type!=="approved_leave" &&
        !(r.exception_type==="unavailable" && !r.start_local && !r.end_local) &&
        <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[17px]">{t("start")}
          <input type="time" className={field} value={r.start_local}
            onChange={e=>update(i,{start_local:e.target.value})}/>
        </label>
        <label className="flex flex-col gap-1 text-[17px]">{t("end")}
          <input type="time" className={field} value={r.end_local}
            onChange={e=>update(i,{end_local:e.target.value})}/>
        </label>
      </div>}
      {r.exception_type!=="hours_cap" && r.exception_type!=="approved_leave" &&
       <label className="flex min-h-12 items-center gap-2 text-[17px]">
         <input type="checkbox" checked={r.overnight}
           onChange={e=>update(i,{overnight:e.target.checked})}/>{t("overnight")}
       </label>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[17px]">{t("source")}
          <select className={field} value={r.source}
            onChange={e=>update(i,{source:e.target.value as ExceptionDraft["source"]})}>
            <option value="owner_direct">{t("ownerDirect")}</option>
            <option value="worker_reported_by_owner">{t("workerReported")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[17px]">{t("confirmation")}
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
    <p className="text-[17px] text-ink-muted">{t("exceptionPrecedence")}</p>
    {dirty && <p role="status" className="text-[17px] text-warn">{t("unsaved")}</p>}
    {status==="saved" && <p role="status" className="text-[17px] text-good">{t("saved")}</p>}
    {status==="conflict" && <details open className="rounded-xl border border-line p-3">
      <summary className="font-semibold">{t("latestSaved")}</summary>
      {scoped.map(r=><p key={r.id} className="text-[17px]">{t(r.exception_type as ExceptionType)}:
        {" "}{String(r.start_local??"")}–{String(r.end_local??"")}
        {" · "}#{r.revision}</p>)}
      {draft.some(d=>d.id && !scoped.some(r=>r.id===d.id)) &&
        <p className="text-[17px]">{t("deletedDraftRecreate")}</p>}
      {scoped.length===0 && <p className="text-[17px]">{t("notRecorded")}</p>}
      <button type="button" className={secondary} onClick={()=>{
        if (!window.confirm(t("discardEdits"))) return;
        setDraftOverride(null);draftManifest.current=null;setRebasedScoped(null);setReapplyReady(false);setDirty(false);setStatus("idle");
      }}>{t("useLatestSaved")}</button>
    </details>}
    {status==="conflict" && <p role="alert" className="text-[17px] text-warn">{t("conflict")}</p>}
    {status==="error" && <p role="alert" className="text-[17px] text-warn">{t("saveFailed")}</p>}
    <button type="button" className={primary} onClick={save} disabled={pending||!dirty}>
      {pending?t("saving"):t("saveExceptions")}
    </button>
  </fieldset>
    </section>;
}
