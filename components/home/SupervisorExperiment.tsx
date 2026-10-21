"use client";
import {useEffect,useState} from "react";
import {formatCents} from "@/lib/calc";
export type ExperimentCopy={
  open:string;close:string;product:string;increase:string;preview:string;propose:string;
  approve:string;apply:string;done:string;report:string;waiting:string;loading:string;
  error:string;condition:string;confirmNote:string;reportNote:string;
  selectProposal:string;statusDraft:string;statusApproved:string;statusManual:string;
  statusMonitoring:string;statusExecuting:string;statusRejected:string;
  statusInProgress:string;statusComplete:string;statusInsufficient:string;
};
type Item={id:string;name:string;priceCents:number};
type Proposal={id:string;revision:number;status:string;monitoring_start_date:string|null;
  canonical_effect_payload:{productName:string;oldPriceCents:number;newPriceCents:number}};
type Simulation={effect:{productName:string;oldPriceCents:number;newPriceCents:number};
  baseline:{estimatedAdditionalRevenue7DaysCents:number}};
export default function SupervisorExperiment({threadId,locale,copy,initialProposalId,refreshVersion}:{
  threadId:string;locale:"en"|"es"|"ar";copy:ExperimentCopy;initialProposalId?:string;refreshVersion?:number}){
 const [open,setOpen]=useState(Boolean(initialProposalId)),[busy,setBusy]=useState(false);
 const [selectedProposalId,setSelectedProposalId]=useState(initialProposalId??"");
 const [items,setItems]=useState<Item[]>([]),[itemId,setItemId]=useState("");
 const [cents,setCents]=useState("10"),[proposals,setProposals]=useState<Proposal[]>([]);
 const [simulation,setSimulation]=useState<Simulation|null>(null);
 const [report,setReport]=useState<{status:string}|null>(null),[error,setError]=useState(false);
 const endpoint="/api/ai/threads/"+encodeURIComponent(threadId)+"/experiments";
 const listEndpoint=initialProposalId?endpoint+"?proposal="+encodeURIComponent(initialProposalId):endpoint;
 useEffect(()=>{
  let alive=true;
  void fetch(listEndpoint,{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error();return r.json();})
   .then((v:{catalog:Item[];proposals:Proposal[]})=>{
    if(alive){setItems(v.catalog);setItemId(v.catalog[0]?.id??"");setProposals(v.proposals);}
   }).catch(()=>{if(alive)setError(true);});
  return ()=>{alive=false;};
 },[listEndpoint,refreshVersion]);
 const invoke=async(payload:Record<string,unknown>)=>{
  setBusy(true);setError(false);
  try{
   const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
     body:JSON.stringify(payload)});
   if(!response.ok)throw new Error();
   const result=await response.json() as {simulation?:Simulation;report?:{status:string}};
   if(result.simulation)setSimulation(result.simulation);
   if(result.report)setReport(result.report);
   const latest=await fetch(listEndpoint,{cache:"no-store"});
   if(!latest.ok)throw new Error();
   const state=await latest.json() as {proposals:Proposal[]};
   setProposals(state.proposals);
   if(payload.action==="propose"&&state.proposals?.[0]?.id)setSelectedProposalId(state.proposals[0].id);
  }catch{setError(true);}finally{setBusy(false);}
 };
 const p=proposals.find(value=>value.id===(selectedProposalId||initialProposalId))??proposals[0],delta=Number(cents);
 const status=(value:string)=>value==="draft"?copy.statusDraft:
   value==="approved"?copy.statusApproved:value==="manual_pending"?copy.statusManual:
   value==="executing"?copy.statusExecuting:
   value==="committed"||value==="manual_confirmed"?copy.statusMonitoring:
   value==="rejected"||value==="expired"?copy.statusRejected:copy.statusMonitoring;
 const valid=Number.isSafeInteger(delta)&&delta>0&&delta<=100000;
 const actionClass="min-h-12 rounded-full border border-ink px-4 text-[17px] font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
 return <section className="border-t border-[#E9DAC8] bg-white px-3 py-2">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(x=>!x)}
    className={actionClass+" w-full text-start"}>{open?copy.close:copy.open}</button>
  {open&&<div className="space-y-3 p-3 text-[17px] text-ink">
   <label className="block">{copy.product}
    <select className="mt-1 min-h-12 w-full rounded-xl border p-2 text-[17px]"
      value={itemId} onChange={e=>{setItemId(e.target.value);setSimulation(null);}}>
      {items.map(item=><option key={item.id} value={item.id}>
        {item.name} · {formatCents(item.priceCents)}</option>)}</select></label>
   <label className="block">{copy.increase}
    <input type="number" className="mt-1 min-h-12 w-full rounded-xl border p-2 text-[17px]"
      min={1} max={100000} step={1} value={cents}
      onChange={e=>{setCents(e.target.value);setSimulation(null);}}/></label>
   <button className={actionClass} disabled={busy||!itemId||!valid}
     onClick={()=>void invoke({action:"simulate",productId:itemId,increaseCents:delta})}>{copy.preview}</button>
   {simulation&&<div className="space-y-2">
    <p>{simulation.effect.productName}: {formatCents(simulation.effect.oldPriceCents)} → {formatCents(simulation.effect.newPriceCents)}</p>
    <p>{copy.condition} {formatCents(simulation.baseline.estimatedAdditionalRevenue7DaysCents)}</p>
    <button className={actionClass} disabled={busy}
      onClick={()=>void invoke({action:"propose",productId:itemId,increaseCents:delta,
        requestKey:crypto.randomUUID(),locale})}>{copy.propose}</button>
   </div>}
   {proposals.length>0&&<label className="block">{copy.selectProposal}
     <select value={p?.id??""} disabled={busy}
       onChange={e=>{setSelectedProposalId(e.target.value);setReport(null);}}
       className="mt-1 min-h-12 w-full rounded-xl border p-2 text-[17px]">
       {proposals.map(x=><option key={x.id} value={x.id}>
         {x.canonical_effect_payload.productName} — {formatCents(x.canonical_effect_payload.newPriceCents)} · {status(x.status)}
       </option>)}
     </select></label>}
   {p&&<div className="space-y-2 border-t pt-3">
    <p className="font-semibold">{p.canonical_effect_payload.productName}:
      {" "}{formatCents(p.canonical_effect_payload.oldPriceCents)} → {formatCents(p.canonical_effect_payload.newPriceCents)}</p>
    {p.status==="draft"&&<button className={actionClass} disabled={busy}
      onClick={()=>void invoke({action:"approve",proposalId:p.id,revision:p.revision})}>{copy.approve}</button>}
    {p.status==="approved"&&<button className={actionClass} disabled={busy}
      onClick={()=>void invoke({action:"commit",proposalId:p.id,revision:p.revision})}>{copy.apply}</button>}
    {p.status==="manual_pending"&&<>
      <p>{copy.confirmNote} {formatCents(p.canonical_effect_payload.newPriceCents)}</p>
      <button className={actionClass} disabled={busy}
        onClick={()=>void invoke({action:"manual_done",proposalId:p.id,revision:p.revision})}>{copy.done}</button>
    </>}
    {(p.status==="manual_confirmed"||p.status==="committed"||p.status==="monitored")&&<>
      <p>{copy.waiting} {p.monitoring_start_date}</p>
      <button className={actionClass} disabled={busy}
        onClick={()=>void invoke({action:"report",proposalId:p.id})}>{copy.report}</button>
    </>}
   </div>}
   {report&&<p>{copy.reportNote} {report.status==="complete"?copy.statusComplete:
     report.status==="in_progress"?copy.statusInProgress:copy.statusInsufficient}</p>}
   {busy&&<p role="status">{copy.loading}</p>}
   {error&&<p role="alert" className="text-red-700">{copy.error}</p>}
  </div>}
 </section>;
}
