"use client";

import {useEffect,useState} from "react";
import {Clock3,Ellipsis} from "lucide-react";
import {routineCardSchema} from "@/lib/ai/conversations/contracts";
import en from "@/messages/en.json";

const copy=en.SupervisorRoutines;
type Card=ReturnType<typeof routineCardSchema.parse>;

/** The only authority for actions is the authenticated POST route and its
 * revision-fenced database receipt. A historical chat card can be stale. */
export default function SupervisorRoutineInlineCard({block,onEdit,disabled=false}:{
  block:unknown;onEdit?:(prompt:string)=>void;disabled?:boolean;
}){
  const parsed=routineCardSchema.safeParse(block);
  const routineId=parsed.success?parsed.data.routineId:null;
  const [current,setCurrent]=useState<Card|null>(parsed.success?parsed.data:null);
  const [unavailable,setUnavailable]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");

  useEffect(()=>{
    if(!routineId)return;
    const controller=new AbortController();
    void fetch("/api/ai/supervisor/routines",{
      credentials:"same-origin",cache:"no-store",signal:controller.signal,
    }).then(async response=>{
      if(!response.ok)throw Error("read_unavailable");
      const payload=await response.json() as {routines?:unknown[]};
      if(!Array.isArray(payload.routines))throw Error("read_invalid");
      const row=payload.routines.find(item=>item!==null&&typeof item==="object"&&
        (item as {id?:string}).id===routineId) as Record<string,unknown>|undefined;
      if(!row)throw Error("routine_not_accessible");
      const verified=routineCardSchema.safeParse({
        type:"routine_card",routineId:row.id,title:row.title,
        cadence:row.cadence,weekdays:row.weekdays,localTime:row.localTime,
        timezone:row.timezone,status:row.status,revision:row.revision,
      });
      if(!verified.success)throw Error("invalid_routine_receipt");
      if(!controller.signal.aborted){setCurrent(verified.data);setUnavailable(false);}
    }).catch(()=>{if(!controller.signal.aborted)setUnavailable(true);});
    return()=>controller.abort();
  },[routineId]);

  async function change(action:"pause"|"resume"|"delete"){
    if(!current||busy||unavailable||disabled)return;
    if(action==="delete"&&!window.confirm(copy.deleteConfirm))return;
    setBusy(true);setNotice("");setError("");
    try{
      const response=await fetch("/api/ai/supervisor/routines",{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          action,routineId:current.routineId,revision:current.revision,
        }),
      });
      if(!response.ok)throw Error("mutation_failed");
      const result=await response.json() as {routine?:Record<string,unknown>};
      const r=result.routine;
      if(!r||r.id!==current.routineId||typeof r.revision!=="number"||
        r.revision<=current.revision)throw Error("revision_not_verified");
      const updated=routineCardSchema.safeParse({
        type:"routine_card",routineId:r.id,title:r.title,
        cadence:r.cadence,weekdays:r.weekdays,localTime:r.localTime,
        timezone:r.timezone,status:r.status,revision:r.revision,
      });
      if(!updated.success||updated.data.status!==
        (action==="delete"?"revoked":action==="pause"?"paused":"active"))
        throw Error("receipt_not_verified");
      setCurrent(updated.data);
      setNotice(action==="delete"?copy.deleteSaved:copy.saved);
    }catch{
      setError(copy.saveFailed);
      // Do not optimistically claim a state that the server did not confirm.
      setUnavailable(true);
    }finally{setBusy(false);}
  }

  if(!parsed.success||!current)return null;
  const isDeleted=current.status==="revoked";
  // ISO weekday labels come from the same verified English locale copy as
  // the owner routines drawer. Do not synthesize arbitrary dates in the UI.
  const localDay=current.cadence==="weekly"?
    current.weekdays.map(day=>en.SupervisorExperience.weekdayNames[day-1])
      .filter(Boolean).join(", "):current.cadence;
  const label=isDeleted?copy.deleteSaved:current.status==="active"?"Active":copy.paused;
  return <section data-routine-card={current.routineId}
    aria-label={current.title}
    className="min-w-0 max-w-lg rounded-xl border border-line bg-surface px-3 py-2">
    <div className="flex items-center gap-2">
      <Clock3 size={16} className="shrink-0 text-ink-muted" aria-hidden="true"/>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-[14px]">{current.title}</strong>
        <span className="block truncate text-[12px] text-ink-muted">
          {localDay} · {current.localTime} · {label}
        </span>
      </div>
      {!isDeleted&&<details className="shrink-0">
        <summary aria-label={copy.actions+": "+current.title}
          className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          <Ellipsis size={20} aria-hidden="true"/>
        </summary>
        <div role="group" aria-label={copy.actions} className="mt-1 flex flex-col gap-1">
          <button type="button" disabled={disabled||busy||unavailable||!onEdit}
            onClick={()=>onEdit?.("Edit my "+current.title+" routine: ")}
            className="min-h-11 rounded-lg px-3 text-start text-[14px] hover:bg-surface2 disabled:opacity-50">{copy.editInChat}</button>
          <button type="button" disabled={disabled||busy||unavailable}
            onClick={()=>void change(current.status==="active"?"pause":"resume")}
            className="min-h-11 rounded-lg px-3 text-start text-[14px] hover:bg-surface2 disabled:opacity-50">
            {current.status==="active"?copy.pause:copy.resume}
          </button>
          <button type="button" disabled={disabled||busy||unavailable}
            onClick={()=>void change("delete")}
            className="min-h-11 rounded-lg px-3 text-start text-[14px] text-neg hover:bg-surface2 disabled:opacity-50">{copy.delete}</button>
        </div>
      </details>}
    </div>
    {notice&&<p role="status" className="text-xs text-ink-muted">{notice}</p>}
    {error&&<p role="alert" className="text-xs text-neg">{error}</p>}
    {unavailable&&!error&&<p role="status" className="text-xs text-ink-muted">{copy.saveFailed}</p>}
  </section>;
}
