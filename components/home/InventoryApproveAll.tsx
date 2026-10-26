"use client";
import {useEffect,useState} from "react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {ProposalView} from "./SupervisorProposalCard";

export default function InventoryApproveAll({threadId,ids,locale}:{
 threadId:string;ids:string[];locale:"en"|"es"|"ar"
}){
 const [cards,setCards]=useState<ProposalView[]>([]);
 const [busy,setBusy]=useState(false);
 const [result,setResult]=useState<{saved:number;failed:number}|null>(null);
 const t={en,es,ar}[locale].InventoryApprovalCard;
 const endpoint="/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals";
 const keys=ids.join(",");
 useEffect(()=>{
  if(ids.length<2)return;
  let live=true;
  void fetch(endpoint+"?ids="+encodeURIComponent(keys),{cache:"no-store"})
   .then(r=>{if(!r.ok)throw Error("read");return r.json();})
   .then((data:{cards:ProposalView[]})=>{
    if(live)setCards(data.cards.filter(card=>card.capabilityId==="maya.inventory_purchase.v1"));
   }).catch(()=>{if(live)setResult({saved:0,failed:ids.length});});
  return ()=>{live=false;};
 },[endpoint,keys]);
 if(cards.length<2)return null;
 const available=cards.some(card=>["pending","failed","conflict"].includes(card.state));
 const approve=async()=>{
  if(busy)return;
  setBusy(true);setResult(null);
  let saved=0,failed=0;
  // Sequential by design: a failure does not cancel or stale any sibling card.
  for(const card of cards){
   if(!["pending","failed","conflict"].includes(card.state))continue;
   if(!card.purchase?.ingredientId){failed++;continue;}
   try{
    const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
     credentials:"same-origin",body:JSON.stringify({action:"approve",proposalId:card.proposalId,revision:card.revision})});
    const outcome=await response.json() as {proposal?:ProposalView};
    if(outcome.proposal?.state==="applied")saved++;
    else failed++;
   }catch{failed++;}
  }
  try{
   const response=await fetch(endpoint+"?ids="+encodeURIComponent(ids.join(",")),{cache:"no-store"});
   if(response.ok){
    const data=await response.json() as {cards:ProposalView[]};
    setCards(data.cards.filter(card=>card.capabilityId==="maya.inventory_purchase.v1"));
   }
  }catch{/* Per-line results remain visible even if refresh fails. */}
  window.dispatchEvent(new Event("aicafe:purchase-cards-updated"));
  setResult({saved,failed});setBusy(false);
 };
 return <div dir={locale==="ar"?"rtl":"ltr"} className="my-3 space-y-2 rounded-xl border border-line bg-surface p-3">
  {available&&<button type="button" disabled={busy} onClick={()=>void approve()}
    className="min-h-12 rounded-xl bg-accent px-4 text-[17px] font-semibold text-on-accent disabled:opacity-50">
    {t.approveAll}</button>}
  {result&&<p role="status" className="text-[17px]">
   {(result.failed?t.approveAllPartial:t.approveAllDone)
    .replace("{saved}",new Intl.NumberFormat(locale).format(result.saved))
    .replace("{failed}",new Intl.NumberFormat(locale).format(result.failed))}
  </p>}
 </div>;
}
