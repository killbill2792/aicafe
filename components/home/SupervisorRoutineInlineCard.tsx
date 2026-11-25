"use client";

import {useEffect,useState} from "react";
import {Clock3,Ellipsis} from "lucide-react";
import {routineCardSchema,routineDraftSchema} from "@/lib/ai/conversations/contracts";
import en from "@/messages/en.json";

const copy=en.SupervisorRoutines;
type Card=ReturnType<typeof routineCardSchema.parse>;

/** The only authority for actions is the authenticated POST route and its
 * revision-fenced database receipt. A historical chat card can be stale. */
export default function SupervisorRoutineInlineCard({block,onEdit,disabled=false,threadId}:{
  block:unknown;onEdit?:(prompt:string)=>void;disabled?:boolean;threadId?:string;
}){
  if(block&&typeof block==="object"&&(block as {type?:unknown}).type==="routine_draft")
    return <RoutineDraft block={block} threadId={threadId} disabled={disabled}/>;
  return <SavedRoutine block={block} onEdit={onEdit} disabled={disabled}/>;
}

/** Approve first: this card only describes the routine. It is saved when the owner taps Save. */
function RoutineDraft({block,threadId,disabled}:{block:unknown;threadId?:string;disabled:boolean}){
  const parsed=routineDraftSchema.safeParse(block);
  const [saved,setSaved]=useState<unknown>(null);
  const [dismissed,setDismissed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  if(saved)return <SavedRoutine block={saved} disabled={disabled}/>;
  if(!parsed.success)return null;
  const d=parsed.data;
  const when=d.cadence==="once"&&d.onceLocalDate?copy.onceOn.replace("{date}",d.onceLocalDate):
    d.cadence==="weekly"?d.weekdays.map(day=>en.SupervisorExperience.weekdayNames[day-1]).filter(Boolean).join(", "):d.cadence;
  async function save(){
    if(busy||!threadId)return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/ai/supervisor/routines",{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"create",threadId,ownerMessageId:d.ownerMessageId,
          goalSourceMessageId:d.goalSourceMessageId,
          schedule:{title:d.title,cadence:d.cadence,weekdays:d.weekdays,localTime:d.localTime,
            ...(d.cadence==="once"?{onceLocalDate:d.onceLocalDate}:{})}}),
      });
      if(!response.ok)throw Error("save_failed");
      const result=await response.json() as {routine?:Record<string,unknown>};
      const r=result.routine;
      const card=routineCardSchema.safeParse({type:"routine_card",routineId:r?.id,title:r?.title,
        cadence:r?.cadence,weekdays:r?.weekdays,localTime:r?.localTime,
        ...(r?.cadence==="once"?{onceLocalDate:r?.onceLocalDate}:{}),
        timezone:r?.timezone,status:r?.status,revision:r?.revision});
      if(!card.success)throw Error("receipt_not_verified");
      setSaved(card.data);
    }catch{setError(copy.saveFailed);}
    finally{setBusy(false);}
  }
  if(dismissed)return <p role="status" className="text-[0.875rem] text-ink-muted">{copy.dismissed}</p>;
  return <section data-routine-draft aria-label={d.title} className="glass min-w-0 max-w-lg rounded-3xl p-4">
    <p className="flex items-center gap-2 text-[0.875rem] text-ink-muted"><Clock3 size={16} className="shrink-0" aria-hidden="true"/>{copy.draftTitle}</p>
    <p className="mt-1 break-words text-[1.0625rem] font-medium text-ink">{d.title}</p>
    <p className="text-[0.875rem] text-ink-muted">{when} · {d.localTime}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={()=>void save()} disabled={busy||disabled||!threadId}
        className="min-h-[max(56px,3.5rem)] max-w-full rounded-full bg-accent px-4 text-[0.9375rem] font-medium text-on-accent disabled:opacity-50">{copy.save}</button>
      <button type="button" onClick={()=>setDismissed(true)} disabled={busy}
        className="min-h-[max(48px,3rem)] rounded-full px-4 text-[0.9375rem] text-ink-muted hover:bg-surface2">{copy.notNow}</button>
    </div>
    {error&&<p role="alert" className="mt-2 text-[0.875rem] text-neg">{error}</p>}
  </section>;
}

function SavedRoutine({block,onEdit,disabled=false}:{
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
    let retry:ReturnType<typeof setTimeout>|null=null;
    async function load(attempt:0|1){
      try{
        const response=await fetch("/api/ai/supervisor/routines",{
          credentials:"same-origin",cache:"no-store",signal:controller.signal,
        });
        if(!response.ok)throw Error(response.status>=500?"transient_read":"read_unavailable");
        const payload=await response.json() as {routines?:unknown[]};
        if(!Array.isArray(payload.routines))throw Error("read_invalid");
        const row=payload.routines.find(item=>item!==null&&typeof item==="object"&&
          (item as {id?:string}).id===routineId) as Record<string,unknown>|undefined;
        if(!row)throw Error("routine_not_accessible");
        const verified=routineCardSchema.safeParse({
          type:"routine_card",routineId:row.id,title:row.title,
          cadence:row.cadence,weekdays:row.weekdays,localTime:row.localTime,
        ...(row.cadence==="once"?{onceLocalDate:row.onceLocalDate}:{}),
          timezone:row.timezone,status:row.status,revision:row.revision,
        });
        if(!verified.success)throw Error("invalid_routine_receipt");
        if(!controller.signal.aborted){setCurrent(verified.data);setUnavailable(false);}
      }catch(error){
        if(controller.signal.aborted)return;
        // One transient server/network read can occur while a locally hosted
        // Next.js route compiles. Never retry an owner/tenant denial, a missing
        // routine, an invalid receipt, or a stale revision as though it passed.
        if(attempt===0&&(error instanceof TypeError||
          error instanceof Error&&error.message==="transient_read")){
          retry=setTimeout(()=>{void load(1);},400);
        }else setUnavailable(true);
      }
    }
    void load(0);
    return()=>{controller.abort();if(retry!==null)clearTimeout(retry);};
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
        ...(r.cadence==="once"?{onceLocalDate:r.onceLocalDate}:{}),
        timezone:r.timezone,status:r.status,revision:r.revision,
      });
      if(!updated.success||updated.data.status!==
        (action==="delete"?"revoked":action==="pause"?"paused":"active"))
        throw Error("receipt_not_verified");
      setCurrent(updated.data);
      setNotice(action==="delete"?copy.deleteSaved:action==="pause"?copy.pausedSaved:copy.resumedSaved);
    }catch{
      setError(copy.saveFailed);
      // Do not optimistically claim a state that the server did not confirm.
      setUnavailable(true);
    }finally{setBusy(false);}
  }

  if(!parsed.success||!current)return null;
  const isDeleted=current.status==="revoked";
  // Draft preparation is inert and safe when chat sending is unavailable.
  // Actual pause/delete still require a current owner-scoped SQL receipt.
  // ISO weekday labels come from the same verified English locale copy as
  // the owner routines drawer. Do not synthesize arbitrary dates in the UI.
  const localDay=current.cadence==="once"&&current.onceLocalDate?
    copy.onceOn.replace("{date}",current.onceLocalDate):
    current.cadence==="weekly"?
      current.weekdays.map(day=>en.SupervisorExperience.weekdayNames[day-1])
        .filter(Boolean).join(", "):current.cadence;
  // The displayed status follows the actual verified receipt and read-back.
  const label=notice || (isDeleted?copy.deleteSaved:
    current.status==="paused"?copy.pausedSaved:
    current.revision===1?copy.created:copy.updated);
  return <section data-routine-card={current.routineId}
    aria-label={current.title} className="min-w-0 max-w-lg">
    <div className="flex min-h-12 items-center gap-2 text-[1.0625rem] text-ink-muted">
      <Clock3 size={16} className="shrink-0" aria-hidden="true"/>
      <span role="status" className="min-w-0 flex-1">{label}</span>
      {!isDeleted&&<details className="relative shrink-0">
        <summary aria-label={copy.actions+": "+current.title}
          className="flex min-h-12 min-w-12 cursor-pointer list-none items-center justify-center rounded-full hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          <Ellipsis size={20} aria-hidden="true"/>
        </summary>
        <div role="group" aria-label={copy.actions} className="absolute end-0 top-full z-10 mt-1 flex min-w-44 flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-lg">
          <p className="max-w-64 break-words px-2 text-[0.875rem] font-medium text-ink">{current.title}</p>
          <p className="px-2 text-[0.8125rem] text-ink-muted">{localDay} · {current.localTime} · {current.timezone}</p>
          <button type="button" disabled={busy||unavailable||!onEdit}
            onClick={()=>onEdit?.("Edit saved routine \""+current.title+"\" (routine ID "+current.routineId+", revision "+current.revision+"): ")}
            className="min-h-12 rounded-lg px-3 text-start text-[0.875rem] hover:bg-surface2 disabled:opacity-50">{copy.editInChat}</button>
          <button type="button" disabled={disabled||busy||unavailable}
            onClick={()=>void change(current.status==="active"?"pause":"resume")}
            className="min-h-12 rounded-lg px-3 text-start text-[0.875rem] hover:bg-surface2 disabled:opacity-50">
            {current.status==="active"?copy.pause:copy.resume}
          </button>
          <button type="button" disabled={disabled||busy||unavailable}
            onClick={()=>void change("delete")}
            className="min-h-12 rounded-lg px-3 text-start text-[0.875rem] text-neg hover:bg-surface2 disabled:opacity-50">{copy.delete}</button>
        </div>
      </details>}
    </div>
    {error&&<p role="alert" className="text-[0.875rem] text-neg">{error}</p>}
    {unavailable&&!error&&<p role="status" className="text-[0.875rem] text-ink-muted">{copy.saveFailed}</p>}
  </section>;
}
