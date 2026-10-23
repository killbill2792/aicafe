"use client";

import {useRef,useState,useTransition} from "react";
import {useLocale,useTranslations} from "next-intl";
import {stableCreateRequestKey,type PendingCreate}
  from "@/lib/scheduling/idempotencyClient";
import {approveOliviaWeek,publishOliviaWeek,readOliviaPublishedWeek}
  from "@/lib/actions/oliviaPlanning";

type Revision={id:string;revision:number;status:string};
type PublishedRow={id:string;employee_id:string;location_id:string;
  starts_at:string;ends_at:string;paid_minutes:number};
function localTime(value:string,zone:string,locale:string){
  try {return new Intl.DateTimeFormat(locale,{
    dateStyle:"medium",timeStyle:"short",timeZone:zone,
  }).format(new Date(value));}catch{return value;}
}

/** Official Olivia schedules are explicitly planned, never worked timecards.
 * The server controls permission and checks status/authoritative source again.
 */
export default function OliviaPublicationPanel({week,latest,publishedRevision,
  enabled,employees,locations,names,onChanged}:{
  week:string;latest:Revision|null;publishedRevision:number|null;
  enabled:boolean;employees:Record<string,string>;
  locations:Record<string,string>;names:Record<string,string>;
  onChanged:()=>Promise<void>;
}){
  const t=useTranslations("OliviaPlanning"),locale=useLocale();
  const revisionLabel=(status:string)=>t(({
    draft:"revisionDraft",approved:"revisionApproved",
    published:"revisionPublished",superseded:"revisionSuperseded",
  } as Record<string,string>)[status]??"revisionUnknown");
  const [pending,start]=useTransition();
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [rows,setRows]=useState<PublishedRow[]|null>(null);
  const retry=useRef<PendingCreate>(null);
  const errors:Record<string,string>={
    disabled:"publishNotReady",policy_unverified:"publishPolicy",
    source_changed:"sourceChanged",revision_conflict:"revisionConflict",
    not_approved:"notApproved",legacy_conflict:"legacyConflict",
    published_overlap:"publishedConflict",past_shift:"pastShift",
    invalid_shifts:"editInvalidGeneric",missing_inputs:"missingInputs",
    unauthorized:"ownerRequired",storage_unavailable:"publishError",
    conflict:"revisionConflict",
  };
  function load(){
    setError("");setRows(null);start(async()=>{
      try {
        const response=await readOliviaPublishedWeek({week});
        if(!response.ok){setRows(null);setError(t("publishError"));return;}
        setRows(response.assignments as PublishedRow[]);
      }catch{setRows(null);setError(t("publishError"));}
    });
  }
  function transition(kind:"approve"|"publish"){
    if(!latest)return;
    if(kind==="publish" && !window.confirm(t("confirmPublish")))return;
    const intent={week,revisionId:latest.id,expectedRevision:latest.revision,kind};
    const requestKey=stableCreateRequestKey(retry,intent);
    setError("");setNotice("");
    start(async()=>{
      try{
        const raw={week,revisionId:latest.id,
          expectedRevision:latest.revision,requestKey};
        const result=kind==="approve"?
          await approveOliviaWeek(raw):await publishOliviaWeek(raw);
        if(!result.ok){
          setError(t(errors[result.error]??"publishError"));return;
        }
        retry.current=null;
        setNotice(t(kind==="approve"?"approvedRevision":"publishedVersion",{
          revision:result.revision,
        }));
        await onChanged();
        if(kind==="publish"){
          // Never present a stale official version after a successful commit.
          // If readback fails, show a retriable error instead of old rows.
          setRows(null);
          const check=await readOliviaPublishedWeek({week});
          if(check.ok)setRows(check.assignments as PublishedRow[]);
          else setError(t("publishError"));
        }
      }catch{setRows(null);setError(t("publishError"));}
    });
  }
  return <section className="flex flex-col gap-3 rounded-xl border border-line p-3">
    <h3 className="font-bold">{t("approvalTitle")}</h3>
    <p className="text-sm text-ink-muted">{t("approvalExplanation")}</p>
    {!enabled && <p role="status" className="text-sm text-ink-muted">
      {t("publishNotReady")}
    </p>}
    <p className="text-sm">{t("latestVersion")}:
      {latest? ` V${latest.revision} · ${revisionLabel(latest.status)}`:t("none")}</p>
    {latest?.status==="draft" &&
      <button type="button" onClick={()=>transition("approve")}
        disabled={pending||!enabled}
        className="min-h-12 rounded-full border border-ink px-4 font-bold disabled:opacity-50">
        {t("approveSchedule")}
      </button>}
    {latest?.status==="approved" &&
      <button type="button" onClick={()=>transition("publish")}
        disabled={pending||!enabled}
        className="min-h-12 rounded-full bg-accent px-4 font-bold text-on-accent disabled:opacity-50">
        {t("publishSchedule")}
      </button>}
    {error&&<p role="alert" className="text-sm text-warn">{error}</p>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
    <div className="border-t border-line pt-3">
      <p className="font-semibold">{t("officialVersion")}: {publishedRevision??t("none")}</p>
      <p className="text-sm text-ink-muted">{t("publishedNotAttendance")}</p>
      <button type="button" onClick={load} disabled={pending}
        className="min-h-12 font-semibold underline">{t("viewOfficial")}</button>
      {rows!==null && (rows.length?rows.map(row=>
        <div key={row.id} className="rounded-xl border border-line p-3 text-sm">
          <strong>{employees[row.employee_id]??row.employee_id}</strong>
          <p>{localTime(row.starts_at,locations[row.location_id]??"UTC",locale)}
            {" — "}
            {localTime(row.ends_at,locations[row.location_id]??"UTC",locale)}</p>
          <p>{names[row.location_id]??row.location_id}
            {" · "}{t("paidMinutes")}: {row.paid_minutes}</p>
        </div>):<p className="text-sm">{t("noOfficialShifts")}</p>)}
    </div>
  </section>;
}
