"use client";
import {useEffect,useState} from "react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {formatCents} from "@/lib/calc";
import {menuPriceDelta,priceInputCents,priceEditString} from "@/lib/calc/menuPriceProposal";
type Locale="en"|"es"|"ar";
export type ProposalView={proposalId:string;revision:number;state:string;capabilityId?:string;
  productName?:string;oldPriceCents?:number;newPriceCents?:number;
  preview?:Array<{label:string;before:string;after:string}>;
  currentPriceCents?:number|null;editedByOwner?:boolean};
const dict={en,es,ar} as const;
export default function SupervisorProposalCard({threadId,proposalId,locale}:{
  threadId:string;proposalId:string;locale:Locale;
}){
  const copy=dict[locale].SupervisorProposalCard;
  const [value,setValue]=useState<ProposalView|null>(null);
  const [busy,setBusy]=useState(false);
  const [editing,setEditing]=useState(false);
  const [price,setPrice]=useState("");
  const [error,setError]=useState(false);
  const endpoint="/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals";
  useEffect(()=>{
    let alive=true;
    void fetch(endpoint+"?ids="+encodeURIComponent(proposalId),{cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json();})
      .then((data:{cards:ProposalView[]})=>{if(alive)setValue(data.cards[0]??null);})
      .catch(()=>{if(alive)setError(true);});
    return ()=>{alive=false;};
  },[endpoint,proposalId]);
  // An executing approval can still be writing in another tab. Refresh only
  // that state; never label an unverified in-flight operation as a failed write.
  useEffect(()=>{
    if(value?.state!=="applying")return;
    let alive=true;
    const interval=setInterval(()=>{
      void fetch(endpoint+"?ids="+encodeURIComponent(proposalId),{cache:"no-store"})
        .then(r=>{if(!r.ok)throw Error();return r.json();})
        .then((result:{cards:ProposalView[]})=>{
          if(alive&&result.cards[0])setValue(result.cards[0]);
        }).catch(()=>{});
    },3000);
    return ()=>{alive=false;clearInterval(interval);};
  },[endpoint,proposalId,value?.state]);
  const invoke=async(action:"approve"|"cancel"|"edit")=>{
    if(!value||busy)return;
    const cents=priceInputCents(price);
    if(action==="edit"&&cents===null){
      setError(true);return;
    }
    setBusy(true);setError(false);
    if(action==="approve")setValue({...value,state:"applying"});
    try{
      const response=await fetch(endpoint,{method:"POST",
        headers:{"content-type":"application/json"},credentials:"same-origin",
        body:JSON.stringify({action,proposalId:value.proposalId,revision:value.revision,
          ...(action==="edit"?{newPriceCents:cents}:{})})});
      const result=await response.json() as {proposal?:ProposalView;state?:string;currentPriceCents?:number};
      if(!response.ok && result.proposal?.state!=="applied" && result.proposal?.state!=="stale" && result.state!=="stale")setError(true);
      if(result.state==="unchanged"){
        // A 422 is form validation; the stored draft is still actionable.
        setValue(value);setError(true);
      }else if(result.proposal)setValue(result.proposal);
      else if(result.state==="stale"||result.state==="conflict")
        setValue({...value,state:result.state,currentPriceCents:result.currentPriceCents});
      else if(!response.ok){setValue(value);setError(true);}
      if(action==="edit"&&response.ok)setEditing(false);
    }catch{setValue(value);setError(true);}
    finally{setBusy(false);}
  };
  if(!value)return error?<p role="alert">{copy.error}</p>:<p role="status">{copy.loading}</p>;
  const money=(cents:number)=>formatCents(cents,locale);
  const staff=value.capabilityId?.startsWith("olivia.staff_")===true;
  const staffCopy=dict[locale].StaffApprovalCard;
  if(staff){
    const statuses:Record<string,string>={pending:staffCopy.pending,applying:staffCopy.applying,
      applied:staffCopy.applied,cancelled:staffCopy.cancelled,stale:staffCopy.stale,
      failed:staffCopy.failed};
    const pending=value.state==="pending"&&!busy;
    const retry=value.state==="failed"&&!busy;
    const button="min-h-12 min-w-12 rounded-xl px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
    return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={staffCopy.title}
      className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xl font-bold">{staffCopy.title}</h3>
        <span role="status" className="rounded-full bg-surface2 px-3 py-1 text-sm font-bold">
          {statuses[value.state]??staffCopy.failed}
        </span>
      </div>
      <p className="mt-2 text-[17px] text-ink-muted">{staffCopy.reviewNotice}</p>
      <div className="mt-3 space-y-3">
        {(value.preview??[]).map((line,index)=><div key={index}
          className="min-w-0 rounded-xl border border-line p-3">
          <p className="font-bold text-[17px]">{line.label}</p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0"><p className="text-sm font-semibold text-ink-muted">{staffCopy.before}</p>
              <p className="whitespace-pre-wrap break-words text-[17px]">{line.before}</p></div>
            <div className="min-w-0"><p className="text-sm font-semibold text-ink-muted">{staffCopy.after}</p>
              <p className="whitespace-pre-wrap break-words text-[17px]">{line.after}</p></div>
          </div>
        </div>)}
      </div>
      {value.capabilityId==="olivia.staff_propose_send_schedule.v1"&&
        <p className="mt-3 text-[17px]">{staffCopy.preparedOnly}</p>}
      {(pending||retry)&&<div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={button+" bg-accent text-on-accent"}
          onClick={()=>void invoke("approve")}>{retry?staffCopy.retry:staffCopy.approve}</button>
        {pending&&<button type="button" disabled={busy} className={button+" border border-line"}
          onClick={()=>void invoke("cancel")}>{staffCopy.decline}</button>}
      </div>}
      {value.state==="stale"&&<p role="alert" className="mt-3 text-neg">{staffCopy.staleDetails}</p>}
      {(error||value.state==="failed")&&<p role="alert" className="mt-3 text-neg">{staffCopy.error}</p>}
    </section>;
  }
  const delta=menuPriceDelta(value.oldPriceCents!,value.newPriceCents!);
  const pending=value.state==="pending"&&!busy;
  const statuses=copy.states as Record<string,string>;
  const button="min-h-12 min-w-12 rounded-xl px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
  return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={copy.title}
    className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[15px] font-semibold text-ink-muted">{copy.proposedBy}</p>
      <span role="status" className="rounded-full bg-surface2 px-3 py-1 text-sm font-bold">{statuses[value.state]??copy.states.failed}</span>
    </div>
    <h3 className="mt-2 break-words text-xl font-bold">{value.productName}</h3>
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[17px]">
      <span>{money(value.oldPriceCents!)}</span><span aria-hidden="true">→</span>
      <strong>{money(value.newPriceCents!)}</strong>
      <span className="text-ink-muted">({delta.increased?"+":""}{money(delta.deltaCents)})</span>
    </div>
    {value.editedByOwner&&<p className="mt-2">{copy.editedByYou}</p>}
    {value.state==="stale"&&<p className="mt-2">{copy.stale} {value.currentPriceCents!=null?money(value.currentPriceCents):""}</p>}
    {value.state==="failed"&&<p className="mt-2">{copy.failed}</p>}
    {pending&&<div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={button+" bg-accent text-on-accent"}
        onClick={()=>void invoke("approve")}>{copy.approve}</button>
      <button type="button" disabled={busy} className={button+" border border-line"}
        onClick={()=>{setEditing(x=>!x);setPrice(priceEditString(value.newPriceCents!));}}>{copy.edit}</button>
      <button type="button" disabled={busy} className={button+" border border-line"}
        onClick={()=>void invoke("cancel")}>{copy.cancel}</button>
    </div>}
    {pending&&editing&&<form className="mt-3 flex flex-col gap-2" onSubmit={e=>{e.preventDefault();void invoke("edit");}}>
      <label htmlFor={"proposal-price-"+proposalId} className="text-[17px] font-semibold">{copy.newPrice}</label>
      <input id={"proposal-price-"+proposalId} type="number" inputMode="decimal" min="0.01" max="1000"
        step="0.01" value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}
        className="min-h-12 min-w-0 w-full rounded-xl border border-line p-3 text-[17px]"/>
      <button type="submit" disabled={busy} className={button+" self-start bg-accent text-on-accent"}>{copy.save}</button>
    </form>}
    {error&&<p role="alert" className="mt-2 text-neg">{copy.error}</p>}
  </section>;
}
