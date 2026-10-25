"use client";
import {useRef,useState} from "react";
import {useTranslations} from "next-intl";
import {useRouter} from "next/navigation";
import {draftStaffWeekInPlace,reviseStaffWeekDraft} from "@/lib/actions/staffDraftInPlace";
import {reviewStaffDraft,type StaffDraftInputShift} from "@/lib/calc/scheduling/staffDraftReview";
import type {PersonForSchedule,AvailabilityEntry,DetailedShift} from "@/lib/calc/scheduling/schedulePresentation";
import type {RuleSettings} from "@/lib/calc/scheduling/ruleChecks";
import type {OpenHours} from "@/lib/business/openHours";
import StaffDialog from "./StaffDialog";

type Data={team:PersonForSchedule[];rules:RuleSettings&{coverage_enabled:boolean;min_headcount:number};
  availability:AvailabilityEntry[];dates:string[];openHours:OpenHours|null;
  timezone:string;adjacentShifts:DetailedShift[];currency:string};
type Proposal={proposalId:string;revision:number;state:string};
export default function StaffDraftApprovalCard({week,locale,data,onClose,onApplied}:{
  week:string;locale:string;data:Data;onClose:()=>void;onApplied:()=>void;
}){
  const t=useTranslations("StaffSchedule");const router=useRouter();
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [proposal,setProposal]=useState<Proposal|null>(null);
  const [threadId,setThreadId]=useState(""),[rows,setRows]=useState<StaffDraftInputShift[]>([]);
  const [review,setReview]=useState(true),[editing,setEditing]=useState<number|null>(null);
  const [draftEdited,setDraftEdited]=useState<StaffDraftInputShift|null>(null);
  const [warning,setWarning]=useState(false);
  const [rates,setRates]=useState<Record<string,number|null>>({});
  const threadRequest=useRef<string|null>(null),draftRequest=useRef<string|null>(null);
  const coverage=data.rules.coverage_enabled?{dates:data.dates,
    openHours:data.openHours,minHeadcount:data.rules.min_headcount}:undefined;
  const preview=reviewStaffDraft(rows,data.team,data.rules,data.availability,
    data.timezone,data.adjacentShifts,rates,coverage);
  const money=(cents:number)=>new Intl.NumberFormat(locale,{style:"currency",currency:data.currency}).format(cents/100);
  const num=(n:number,maximumFractionDigits=0)=>new Intl.NumberFormat(locale,{maximumFractionDigits}).format(n);
  const localTime=(date:string,clock:string)=>new Intl.DateTimeFormat(locale,{
    hour:"numeric",minute:"2-digit",timeZone:"UTC"
  }).format(new Date(date+"T"+clock+":00Z"));
  async function createThread(){
    const response=await fetch("/api/ai/threads",{method:"POST",
      credentials:"same-origin",headers:{"content-type":"application/json"},
      body:JSON.stringify({requestId:threadRequest.current??(threadRequest.current=crypto.randomUUID())})});
    if(!response.ok)throw new Error("thread");
    const json=await response.json();
    if(typeof json.thread?.id!=="string")throw new Error("thread");
    threadRequest.current=null;
    return json.thread.id as string;
  }
  async function draft(){
    if(busy)return;setBusy(true);setError("");
    try{
      const id=threadId||await createThread();
      setThreadId(id);
      const result=await draftStaffWeekInPlace({week,threadId:id,
        requestKey:draftRequest.current??(draftRequest.current=crypto.randomUUID()),
        locale:locale==="ar"?"ar":locale==="es"?"es":"en"});
      if(!result.ok){if(result.error!=="unavailable")draftRequest.current=null;
        setError(t(result.error==="week"?"draftFutureWeek":
        result.error==="missing"?"draftMissing":"draftUnavailable"));return;}
      draftRequest.current=null;setRates(result.wageRates);
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
      if(!next)throw Error();
      setProposal({proposalId:next.proposalId,revision:next.revision,state:next.state});
      if(next.state==="applied"){onApplied();router.refresh();return;}
      if(next.state==="cancelled"){onClose();return;}
      if(next.state==="stale"){setError(t("draftStale"));return;}
      if(!response.ok||next.state==="failed")throw Error();
    }catch{setError(t("draftActionError"));}
    finally{setBusy(false);}
  }
  async function replaceDraft(changed:StaffDraftInputShift[]){
    if(!proposal||busy)return;
    if(!changed.length){void update("cancel");return;}
    try{reviewStaffDraft(changed,data.team,data.rules,data.availability,
      data.timezone,data.adjacentShifts,rates,coverage);}catch{setError(t("draftInvalidShift"));return;}
    setBusy(true);setError("");
    const previous=proposal;
    let staged:{proposalId:string;revision:number}|null=null;
    const endpoint="/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals";
    const cancel=async(item:{proposalId:string;revision:number})=>{
      const response=await fetch(endpoint,{method:"POST",credentials:"same-origin",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"cancel",proposalId:item.proposalId,revision:item.revision})});
      const body=await response.json();
      return {ok:response.ok,proposal:body.proposal as Proposal|undefined};
    };
    try{
      // Prepare the replacement before cancelling the original. A validation
      // failure must leave the owner's existing approval option intact.
      const result=await reviseStaffWeekDraft({week,threadId,requestKey:crypto.randomUUID(),
        locale:locale==="ar"?"ar":locale==="es"?"es":"en",shifts:changed});
      if(!result.ok)throw Error("revise");
      staged={proposalId:result.proposalId,revision:result.revision};
      const old=await cancel(previous);
      if(old.proposal?.state==="applied"){onApplied();router.refresh();return;}
      if(!old.ok||old.proposal?.state!=="cancelled")throw Error("cancel");
      setRates(result.wageRates);setRows(changed);
      setProposal({...staged,state:"pending"});
      staged=null;
    }catch{
      setError(t("draftEditRequiresRefresh"));
      setProposal(previous);
    }
    finally{
      if(staged){try{await cancel(staged);}catch{/* Inert proposal; CAS still protects writes. */}}
      setBusy(false);
    }
  }
  const saveEdit=()=>{
    if(editing===null||!draftEdited)return;
    const changed=rows.map((row,i)=>i===editing?draftEdited:row);
    if(draftEdited.date<week||
      draftEdited.date>new Date(Date.parse(week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)){
      setError(t("draftInvalidShift"));return;
    }
    // Proposal edits require a fresh, server-validated proposal. Never approve an
    // outdated effect while showing different draft rows.
    setEditing(null);void replaceDraft(changed);
  };
  return <section className="rounded-2xl border border-line bg-surface p-4 text-[17px]" dir={locale==="ar"?"rtl":"ltr"} aria-label={t("draftHeading")}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xl font-bold">{t("draftHeading")}</h2>
      <button type="button" disabled={busy} className="min-h-12 px-3"
        onClick={()=>proposal?.state==="pending"?void update("cancel"):onClose()}>{t("close")}</button>
    </div>
    {!proposal&&<button type="button" disabled={busy} onClick={()=>void draft()}
      className="mt-3 min-h-12 rounded-xl bg-accent px-4 text-on-accent disabled:opacity-50">
      {busy?t("draftWorking"):t("draftThisWeek")}</button>}
    {busy&&<p role="status" className="mt-2 text-muted">{t(proposal?"draftApplying":"draftWorking")}</p>}
    {proposal&&<>
      <p role="status" className="mt-3 font-semibold">{t("draftSummary",{
        shifts:num(preview.totals.shiftCount),hours:num(preview.totals.paidMinutes/60,1),
        cost:preview.totals.unknownCount?t("draftPartialCost",{known:money(preview.totals.knownCostCents),count:num(preview.totals.unknownCount)}):money(preview.totals.knownCostCents),
        issues:num(preview.totals.ruleIssues)})}</p>
      {(warning||preview.totals.estimatedCount>0)&&<p className="mt-2 text-muted">{t("draftEstimateNote")}</p>}
      {preview.totals.coverageGaps>0&&<p role="status"
        className="mt-2 rounded-xl bg-warn-soft p-3 text-warn-text">
        {t("draftCoverageGaps",{count:num(preview.totals.coverageGaps)})}</p>}
      <p className="mt-2 text-muted">{t("draftBaseWageNote")}</p>
      <p className="mt-2 text-muted">{t("draftNotSaved")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy||!["pending","failed"].includes(proposal.state)} onClick={()=>void update("approve")}
          className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent">{proposal.state==="failed"?t("draftRetryApproval"):t("draftApproveAll")}</button>
        <button disabled={busy} onClick={()=>setReview(x=>!x)}
          className="min-h-12 rounded-xl border border-line px-4">{review?t("draftHideReview"):t("draftReview")}</button>
        <button disabled={busy||proposal.state!=="pending"} onClick={()=>void update("cancel")}
          className="min-h-12 rounded-xl border border-line px-4">{t("draftDiscard")}</button>
      </div>
      {review&&<div className="mt-4 space-y-2">
        {preview.shifts.map((s,i)=><div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-dashed border-line p-3">
          <span>{s.name} · {new Intl.DateTimeFormat(locale,{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(s.date+"T12:00:00Z"))} · {localTime(s.date,s.start)}–{localTime(s.date,s.end)}</span>
          <div><button type="button" className="min-h-12 px-3 underline" disabled={busy||proposal.state!=="pending"} onClick={()=>{setError("");setEditing(i);setDraftEdited(rows[i]);}}>{t("edit")}</button>
          <button type="button" className="min-h-12 px-3 text-neg" disabled={busy||proposal.state!=="pending"} onClick={()=>void replaceDraft(rows.filter((_,j)=>i!==j))}>{t("remove")}</button></div>
        </div>)}
      </div>}
    </>}
    {error&&<p role="alert" className="mt-3 text-neg">{error}</p>}
    {editing!==null&&draftEdited&&<StaffDialog headingId="olivia-draft-shift-heading" onClose={()=>setEditing(null)}>
      <h3 id="olivia-draft-shift-heading" className="text-xl font-bold">{t("editShift")}</h3>
      {error&&<p role="alert" className="mt-2 text-neg">{error}</p>}
      <label className="mt-3 block">{t("who")}
        <select value={draftEdited.employee_id}
          onChange={e=>setDraftEdited({...draftEdited,employee_id:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3">
          {data.team.filter(p=>p.active!==false).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
      <label className="mt-3 block">{t("week")}
        <input type="date" value={draftEdited.date} min={week}
          max={new Date(Date.parse(week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)}
          onChange={e=>setDraftEdited({...draftEdited,date:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <label className="mt-3 block">{t("start")}
        <input type="time" value={draftEdited.start} onChange={e=>setDraftEdited({...draftEdited,start:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <label className="mt-3 block">{t("end")}
        <input type="time" value={draftEdited.end} onChange={e=>setDraftEdited({...draftEdited,end:e.target.value})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <label className="mt-3 block">{t("draftBreakMinutes")}
        <input type="number" min="0" max="240" step="1"
          value={draftEdited.break_minutes}
          onChange={e=>setDraftEdited({...draftEdited,break_minutes:Number(e.target.value)})}
          className="mt-1 min-h-12 w-full rounded-xl border border-line p-3"/></label>
      <button type="button" disabled={busy} onClick={saveEdit}
        className="mt-4 min-h-12 w-full rounded-xl bg-accent text-on-accent">{t("saveChanges")}</button>
      <button type="button" className="mt-2 min-h-12 w-full" onClick={()=>setEditing(null)}>{t("cancel")}</button>
    </StaffDialog>}
  </section>;
}
