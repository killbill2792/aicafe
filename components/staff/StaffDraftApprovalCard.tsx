"use client";
import {useState} from "react";
import {useTranslations} from "next-intl";
import {useRouter} from "next/navigation";
import {draftStaffWeekInPlace,reviseStaffWeekDraft} from "@/lib/actions/staffDraftInPlace";
import {reviewStaffDraft,type StaffDraftInputShift} from "@/lib/calc/scheduling/staffDraftReview";
import type {PersonForSchedule,AvailabilityEntry,DetailedShift} from "@/lib/calc/scheduling/schedulePresentation";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";
import StaffDialog from "./StaffDialog";

type Data={team:PersonForSchedule[];rules:RuleSettings;availability:AvailabilityEntry[];
  timezone:string;adjacentShifts:DetailedShift[];currency:string};
type Proposal={proposalId:string;revision:number;state:string};
export default function StaffDraftApprovalCard({week,locale,data,onClose,onApplied}:{
  week:string;locale:string;data:Data;onClose:()=>void;onApplied:()=>void;
  onReviewShift?:(d:string,id?:string,employeeId?:string)=>void
}){
  const t=useTranslations("StaffSchedule");const router=useRouter();
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [proposal,setProposal]=useState<Proposal|null>(null);
  const [threadId,setThreadId]=useState(""),[rows,setRows]=useState<StaffDraftInputShift[]>([]);
  const [review,setReview]=useState(false),[editing,setEditing]=useState<number|null>(null);
  const [draftEdited,setDraftEdited]=useState<StaffDraftInputShift|null>(null);
  const [warning,setWarning]=useState(false);
  const preview=reviewStaffDraft(rows,data.team,data.rules,data.availability,
    data.timezone,data.adjacentShifts);
  const money=(cents:number)=>new Intl.NumberFormat(locale,{style:"currency",currency:data.currency}).format(cents/100);
  const num=(n:number,maximumFractionDigits=0)=>new Intl.NumberFormat(locale,{maximumFractionDigits}).format(n);
  async function createThread(){
    const response=await fetch("/api/ai/threads",{method:"POST",
      credentials:"same-origin",headers:{"content-type":"application/json"},
      body:JSON.stringify({requestId:crypto.randomUUID()})});
    if(!response.ok)throw new Error("thread");
    const json=await response.json();
    if(typeof json.thread?.id!=="string")throw new Error("thread");
    return json.thread.id as string;
  }
  async function draft(){
    if(busy)return;setBusy(true);setError("");
    try{
      const id=threadId||await createThread();
      setThreadId(id);
      const result=await draftStaffWeekInPlace({week,threadId:id,requestKey:crypto.randomUUID(),
        locale:locale==="ar"?"ar":locale==="es"?"es":"en"});
      if(!result.ok){setError(t(result.error==="week"?"draftFutureWeek":
        result.error==="names"?"draftNames":result.error==="missing"?"draftMissing":"draftUnavailable"));return;}
      setRows(result.shifts);setProposal({proposalId:result.proposalId,revision:result.revision,state:"pending"});
      setWarning(result.costIsPartial||result.estimated);
    }catch{setError(t("draftUnavailable"));}
    finally{setBusy(false);}
  }
  async function update(action:"approve"|"cancel"){
    if(!proposal||busy)return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals",{
        method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},
        body:JSON.stringify({action,proposalId:proposal.proposalId,revision:proposal.revision})});
      const result=await response.json();
      const next=result.proposal;
      if(next)setProposal({proposalId:next.proposalId,revision:next.revision,state:next.state});
      if(!response.ok||!next)throw Error();
      if(next.state==="applied"){onApplied();router.refresh();}
      if(next.state==="cancelled")onClose();
      if(next.state==="stale")setError(t("draftStale"));
    }catch{setError(t("draftActionError"));}
    finally{setBusy(false);}
  }
  async function replaceDraft(changed:StaffDraftInputShift[]){
    if(!proposal||busy)return;
    setBusy(true);setError("");
    try{
      const previous=proposal;
      const cancelled=await fetch("/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals",{
        method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"cancel",proposalId:previous.proposalId,revision:previous.revision})});
      if(!cancelled.ok)throw Error("cancel");
      setProposal(null);
      const result=await reviseStaffWeekDraft({week,threadId,requestKey:crypto.randomUUID(),
        locale:locale==="ar"?"ar":locale==="es"?"es":"en",shifts:changed});
      if(!result.ok)throw Error("revise");
      setRows(changed);setProposal({proposalId:result.proposalId,revision:result.revision,state:"pending"});
    }catch{setError(t("draftEditRequiresRefresh"));setProposal(null);}
    finally{setBusy(false);}
  }
  const saveEdit=()=>{
    if(editing===null||!draftEdited)return;
    const changed=rows.map((row,i)=>i===editing?draftEdited:row);
    // Proposal edits require a fresh, server-validated proposal. Never approve an
    // outdated effect while showing different draft rows.
    setEditing(null);void replaceDraft(changed);
  };
  return <section className="rounded-2xl border border-line bg-surface p-4" aria-label={t("draftHeading")}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xl font-bold">{t("draftHeading")}</h2>
      <button type="button" className="min-h-12 px-3" onClick={onClose}>{t("close")}</button>
    </div>
    {!proposal&&<button type="button" disabled={busy} onClick={()=>void draft()}
      className="mt-3 min-h-12 rounded-xl bg-accent px-4 text-on-accent disabled:opacity-50">
      {busy?t("draftWorking"):t("draftThisWeek")}</button>}
    {proposal&&<>
      <p role="status" className="mt-3 font-semibold">{t("draftSummary",{
        shifts:num(preview.totals.shiftCount),hours:num(preview.totals.paidMinutes/60,1),
        cost:preview.totals.unknownCount?t("draftUnknownCost"):money(preview.totals.knownCostCents),
        issues:num(preview.totals.ruleIssues)})}</p>
      {(warning||preview.totals.estimatedCount>0)&&<p className="mt-2 text-muted">{t("draftEstimateNote")}</p>}
      <p className="mt-2 text-muted">{t("draftNotSaved")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy||proposal.state!=="pending"} onClick={()=>void update("approve")}
          className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent">{t("draftApproveAll")}</button>
        <button disabled={busy} onClick={()=>setReview(x=>!x)}
          className="min-h-12 rounded-xl border border-line px-4">{t("draftReview")}</button>
        <button disabled={busy||proposal.state!=="pending"} onClick={()=>void update("cancel")}
          className="min-h-12 rounded-xl border border-line px-4">{t("draftDiscard")}</button>
      </div>
      {review&&<div className="mt-4 space-y-2">
        {preview.shifts.map((s,i)=><div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-dashed border-line p-3">
          <span>{s.name} · {new Intl.DateTimeFormat(locale,{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(s.date+"T12:00:00Z"))} · {s.start}–{s.end}</span>
          <div><button type="button" className="min-h-12 px-3 underline" onClick={()=>{setEditing(i);setDraftEdited(rows[i]);}}>{t("edit")}</button>
          <button type="button" className="min-h-12 px-3 text-neg" onClick={()=>void replaceDraft(rows.filter((_,j)=>i!==j))}>{t("remove")}</button></div>
        </div>)}
      </div>}
    </>}
    {error&&<p role="alert" className="mt-3 text-neg">{error}</p>}
    {editing!==null&&draftEdited&&<StaffDialog headingId="olivia-draft-shift-heading" onClose={()=>setEditing(null)}>
      <h3 id="olivia-draft-shift-heading" className="text-xl font-bold">{t("editShift")}</h3>
      <label className="mt-3 block">{t("start")}
        <input type="time" value={draftEdited.start} onChange={e=>setDraftEdited({...draftEdited,start:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <label className="mt-3 block">{t("end")}
        <input type="time" value={draftEdited.end} onChange={e=>setDraftEdited({...draftEdited,end:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <button type="button" onClick={saveEdit} className="mt-4 min-h-12 w-full rounded-xl bg-accent text-on-accent">{t("saveChanges")}</button>
    </StaffDialog>}
  </section>;
}
