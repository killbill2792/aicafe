"use client";

import { useRef, useState, useTransition } from "react";
import { stableCreateRequestKey, type PendingCreate } from "@/lib/scheduling/idempotencyClient";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { saveSchedulingFoundationRecord, createSchedulingQualificationType, getSchedulingFoundationRecords } from "@/lib/actions/schedulingFoundation";
import { type SchedulingRow, type SchedulingLocation,
 schedulingFieldClass as field, schedulingButtonClass as secondary,
 schedulingPrimaryClass as primary } from "./AvailabilityEditor";

export default function StaffQualificationsEditor({ employeeId, types, assignments, locations, today }: {
  employeeId: string; types: SchedulingRow[]; assignments: SchedulingRow[];
  locations: SchedulingLocation[]; today: string;
}) {
  const t=useTranslations("SchedulingAvailability"),router=useRouter();
  const [newName,setNewName]=useState("");
  const [createdType,setCreatedType]=useState<{code:string;name:string}|null>(null);
  const [code,setCode]=useState(""),[locationId,setLocationId]=useState("");
  const [from,setFrom]=useState(today),[to,setTo]=useState("");
  const [dateEdited,setDateEdited]=useState(false);
  const [source,setSource]=useState<"owner_direct"|"worker_reported_by_owner">("owner_direct");
  const [confirmation,setConfirmation]=useState<"unconfirmed"|"owner_confirmed">("unconfirmed");
  const [error,setError]=useState(""),[saved,setSaved]=useState(false);
  const [pending,startTransition]=useTransition();
  const typeRetry=useRef<PendingCreate>(null), assignmentRetry=useRef<PendingCreate>(null);
  const mine=assignments.filter(r=>r.employee_id===employeeId);
  function issue(errorCode:string) {setError(errorCode);setSaved(false);}
  function addType() {
    const name=newName.trim();
    if (!name) return;
    const existing=types.find(row=>String(row.display_name).toLocaleLowerCase()===
      name.toLocaleLowerCase());
    if (existing) {
      setCode(String(existing.code));setNewName("");setError("");return;
    }
    const payload={displayName:name};
    startTransition(async()=>{
      const result=await createSchedulingQualificationType({
        ...payload,requestKey:stableCreateRequestKey(typeRetry,payload),
      });
      if(!result.ok){
        if(result.error==="conflict_or_missing"){
          // Another owner may have created this label with a different key.
          // Choose its canonical code from a fresh authorized read instead
          // of repeatedly creating the same owner-visible qualification.
          const latest=await getSchedulingFoundationRecords();
          const match=latest.ok ? (latest.records.qualification_type as SchedulingRow[])
            .find(r=>String(r.display_name).trim().toLocaleLowerCase()===name.toLocaleLowerCase()) : undefined;
          if(match){setCode(String(match.code));setNewName("");typeRetry.current=null;}
          router.refresh();issue(t("conflict"));return;
        }
        issue(t("saveFailed"));return;
      }
      setCreatedType({code:result.code,name});setCode(result.code);
      setError("");setSaved(true);typeRetry.current=null;setNewName("");router.refresh();
    });
  }
  function selectLocation(value:string) {
    setLocationId(value);
    if (!dateEdited) setFrom(locations.find(l=>l.id===value)?.todayLocal??today);
  }
  function assign() {
    if (!code){issue(t("chooseQualification"));return;}
    if (mine.some(r=>r.qualification_code===code &&
        (r.location_id??null)===(locationId||null) &&
        r.valid_from===from && (r.valid_to??null)===(to||null))) {
      issue(t("alreadyAssigned"));return;
    }
    const payload={employee_id:employeeId,location_id:locationId||null,qualification_code:code,
      valid_from:from,valid_to:to||null,source,confirmation};
    startTransition(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"qualification",action:"create",requestKey:stableCreateRequestKey(assignmentRetry,payload),
        data:payload,
      });
      if(!result.ok){
        if(result.error==="conflict_or_missing"){
          const latest=await getSchedulingFoundationRecords();
          const duplicate=latest.ok && (latest.records.qualification as SchedulingRow[]).some(r=>
            r.employee_id===employeeId && r.qualification_code===code &&
            (r.location_id??null)===(locationId||null) && r.valid_from===from &&
            (r.valid_to??null)===(to||null));
          router.refresh();issue(t(duplicate?"alreadyAssigned":"conflict"));return;
        }
        issue(t("saveFailed"));return;
      }
      assignmentRetry.current=null;setCode("");setError("");setSaved(true);router.refresh();
    });
  }
  function revoke(r:SchedulingRow) {
    if (!window.confirm(t("confirmRemove")))return;
    startTransition(async()=>{
      const result=await saveSchedulingFoundationRecord({
        kind:"qualification",action:"delete",id:r.id,expectedRevision:r.revision,
      });
      if(!result.ok){issue(t("conflict"));return;}
      setError("");router.refresh();
    });
  }
  const findName=(qualCode:string)=>String(types.find(r=>r.code===qualCode)?.display_name??qualCode);
  return <section className="flex flex-col gap-3 rounded-xl bg-surface p-3">
    <h4 className="text-[17px] font-bold">{t("qualifications")}</h4>
    <p className="text-[17px] text-ink-muted">{t("roleNotQualification")}</p>
    <fieldset disabled={pending} aria-busy={pending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
    {mine.length===0&&<p className="text-[17px] text-ink-muted">{t("noQualifications")}</p>}
    {mine.map(r=><div key={r.id} className="flex items-center justify-between gap-2 rounded-xl border border-line p-3">
      <div className="min-w-0">
        <p className="font-semibold">{findName(String(r.qualification_code))}</p>
        <p className="text-[17px] text-ink-muted">{String(r.valid_from)}
          {r.valid_to?` – ${String(r.valid_to)}`:""}{" · "}
          {r.confirmation==="owner_confirmed"?t("ownerConfirmed"):t("unconfirmed")}
        </p>
      </div>
      <button type="button" className={secondary} onClick={()=>revoke(r)} disabled={pending}>{t("remove")}</button>
    </div>)}
    <label className="flex flex-col gap-1 text-[17px]">{t("qualification")}
      <select className={field} value={code} onChange={e=>setCode(e.target.value)}>
        <option value="">{t("chooseQualification")}</option>
        {types.filter(r=>r.active!==false).map(r=><option key={r.id} value={String(r.code)}>{String(r.display_name)}</option>)}
        {createdType && !types.some(r=>r.code===createdType.code) &&
          <option value={createdType.code}>{createdType.name}</option>}
      </select>
    </label>
    <label className="flex flex-col gap-1 text-[17px]">{t("location")}
      <select className={field} value={locationId} onChange={e=>selectLocation(e.target.value)}>
        <option value="">{t("allLocations")}</option>
        {locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-[17px]">{t("effectiveFrom")}
        <input type="date" className={field} value={from} onChange={e=>{setDateEdited(true);setFrom(e.target.value);}}/>
      </label>
      <label className="flex flex-col gap-1 text-[17px]">{t("effectiveTo")}
        <input type="date" className={field} value={to} onChange={e=>setTo(e.target.value)}/>
      </label>
    </div>
    <label className="flex flex-col gap-1 text-[17px]">{t("source")}
      <select className={field} value={source}
        onChange={e=>setSource(e.target.value as typeof source)}>
        <option value="owner_direct">{t("ownerDirect")}</option>
        <option value="worker_reported_by_owner">{t("workerReported")}</option>
      </select>
    </label>
    <label className="flex flex-col gap-1 text-[17px]">{t("confirmation")}
      <select className={field} value={confirmation}
        onChange={e=>setConfirmation(e.target.value as typeof confirmation)}>
        <option value="unconfirmed">{t("unconfirmed")}</option>
        <option value="owner_confirmed">{t("ownerConfirmed")}</option>
      </select>
    </label>
    <button type="button" className={primary} disabled={pending||!code} onClick={assign}>{t("assignQualification")}</button>
    <details className="rounded-xl border border-line p-3">
      <summary className="min-h-12 cursor-pointer font-semibold">{t("createQualification")}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[17px]">{t("qualificationName")}
          <input className={field} value={newName} onChange={e=>setNewName(e.target.value)}/>
        </label>
        <button type="button" className={secondary} disabled={pending||!newName.trim()} onClick={addType}>{t("createQualification")}</button>
      </div>
    </details>
    {error&&<p role="alert" className="text-[17px] text-warn">{error}</p>}
    {saved&&<p role="status" className="text-[17px] text-good">{t("saved")}</p>}
    </fieldset>
  </section>;
}
