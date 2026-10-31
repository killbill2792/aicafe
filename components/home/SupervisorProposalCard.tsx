"use client";
import {useEffect,useState} from "react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {formatCardValue,diffFields} from "@/lib/format/values";
import BeforeAfterRows,{type ApprovalPreviewRow} from "./BeforeAfterRows";
import OwnerScheduleSendPanel from "@/components/staff/OwnerScheduleSendPanel";
import {scheduleApprovalReply} from "@/lib/calc/scheduling/ownerDeliveryLinks";
import {priceInputCents,priceEditString} from "@/lib/calc/menuPriceProposal";
import {parseOwnerDecimal} from "@/lib/calc/localeDecimal";
import {Lightbulb} from "lucide-react";
import {eventActionAreaLabel} from "@/lib/events/eventActionArea";
type Locale="en"|"es"|"ar";
export type ProposalView={proposalId:string;revision:number;state:string;capabilityId?:string;
  productName?:string;oldPriceCents?:number;newPriceCents?:number;
  preview?:ApprovalPreviewRow[];currency?:string;
  currentPriceCents?:number|null;editedByOwner?:boolean;subjectName?:string|null;
  purchase?:{name:string;ingredientId:string|null;quantity:number;unit:string;costCents:number|null;date:string;source:string;
    receiptGroupId?:string|null;receiptLineIndex?:number|null;receiptVendor?:string|null;receiptTotalCents?:number|null};
  ingredientOptions?:Array<{id:string;name:string;base_unit:string}>;};
const dict={en,es,ar} as const;

/** Historical event proposals are informational. Keep their saved content,
 * but do not present old approval actions or physical checkboxes. */
export function EventReadinessPreview({value,locale}:{value:ProposalView;locale:Locale}){
  const t=dict[locale].EventsPanel;
  const rows=value.preview??[];
  return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={t.savedInsight}
    className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
    <div className="flex items-center gap-2 text-[17px] font-bold text-accent-text">
      <Lightbulb size={22} aria-hidden="true"/><span>{t.savedInsight}</span>
    </div>
    {value.productName&&<h3 className="mt-2 break-words text-xl font-semibold" dir="auto">{value.productName}</h3>}
    {rows.length>0&&<div className="mt-3">
      <h4 className="mb-2 font-semibold">{t.recommendations}</h4>
      <ul className="space-y-3">
        {rows.map((row,index)=>{
          const typed="field" in row;
          const valueToShow=typed?(row.after??row.before):null;
          const detail=typed?(valueToShow?formatCardValue(valueToShow,locale,value.currency??null):null):
            (row.after??row.before);
          return <li key={index} className="flex items-start gap-3 rounded-xl bg-surface2 p-3">
            <Lightbulb size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text"/>
            <div className="min-w-0">
              <p className="font-semibold" dir="auto">{eventActionAreaLabel(row.label,locale)}</p>
              {detail&&<p className="mt-1 whitespace-pre-wrap break-words text-ink-muted" dir="auto">{detail}</p>}
            </div>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
}

export default function SupervisorProposalCard({threadId,proposalId,locale}:{
  threadId:string;proposalId:string;locale:Locale;
}){
  const copy=dict[locale].SupervisorProposalCard;
  const [value,setValue]=useState<ProposalView|null>(null);
  const [busy,setBusy]=useState(false);
  const [editing,setEditing]=useState(false);
  const [price,setPrice]=useState("");
  const [error,setError]=useState(false);
  const [purchaseDraft,setPurchaseDraft]=useState<{
    ingredientId:string|null;quantity:string;unit:string;cost:string;date:string;receiptVendor:string;receiptTotal:string}|null>(null);
  const endpoint="/api/ai/threads/"+encodeURIComponent(threadId)+"/proposals";
  useEffect(()=>{
    let alive=true;
    void fetch(endpoint+"?ids="+encodeURIComponent(proposalId),{cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json();})
      .then((data:{cards:ProposalView[]})=>{if(alive)setValue(data.cards[0]??null);})
      .catch(()=>{if(alive)setError(true);});
    return ()=>{alive=false;};
  },[endpoint,proposalId]);
  useEffect(()=>{
    const refresh=()=>{
      void fetch(endpoint+"?ids="+encodeURIComponent(proposalId),{cache:"no-store"})
       .then(r=>{if(!r.ok)throw Error();return r.json();})
       .then((data:{cards:ProposalView[]})=>{if(data.cards[0])setValue(data.cards[0]);})
       .catch(()=>setError(true));
    };
    window.addEventListener("aicafe:purchase-cards-updated",refresh);
    return ()=>window.removeEventListener("aicafe:purchase-cards-updated",refresh);
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
  const money=(cents:number)=>formatCardValue({kind:"money",cents},locale,value.currency??"USD");
  const staff=value.capabilityId?.startsWith("olivia.staff_")===true;
  const purchase=value.capabilityId==="maya.inventory_purchase.v1";
  const experiment=value.capabilityId==="alex.drink_price_experiment.v1";
  const goal=value.capabilityId==="leo.goal.v1";
  const eventPlan=value.capabilityId==="alex.event_readiness.v1";
  const staffCopy=dict[locale].StaffApprovalCard;
  if(eventPlan)return <EventReadinessPreview value={value} locale={locale}/>;
  if(purchase&&value.purchase){
    const copy=dict[locale].InventoryApprovalCard;
    const p=value.purchase;
    const edit=purchaseDraft;
    const receiptComplete=p.source!=="receipt_chat"||Boolean(p.receiptVendor&&p.receiptTotalCents&&p.costCents!==null);
    const pending=value.state==="pending"&&!busy;
    const canRetry=["failed","conflict"].includes(value.state)&&!busy;
    const label=value.state==="applied"?copy.applied:
      value.state==="cancelled"?copy.skipped:
      value.state==="failed"?copy.failed:value.state==="applying"?copy.applying:copy.pending;
    const button="min-h-12 rounded-xl border border-line px-4 text-[17px] font-bold disabled:opacity-50";
    const selected=edit?.ingredientId??p.ingredientId;
    const submit=async(action:"approve"|"cancel"|"edit_purchase")=>{
      if(busy)return;
      const quantity=edit?parseOwnerDecimal(edit.quantity,locale):p.quantity;
      const moneyValue=edit?.cost.trim()?parseOwnerDecimal(edit.cost,locale):null;
      const cents=moneyValue===null?null:Math.round(moneyValue*100);
      const receiptAmount=edit?.receiptTotal.trim()?parseOwnerDecimal(edit.receiptTotal,locale):null;
      const receiptTotalCents=receiptAmount===null?null:Math.round(receiptAmount*100);
      if(action==="edit_purchase"&&(!edit||quantity===null||quantity<=0||
        (edit.cost.trim()&&cents===null)||
        (p.source==="receipt_chat"&&(!edit.receiptVendor.trim()||!receiptTotalCents||cents===null)))){
        setError(true);return;}
      setBusy(true);setError(false);
      try{
        const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},
          credentials:"same-origin",body:JSON.stringify({
            action,proposalId:value.proposalId,revision:value.revision,
            ...(action==="edit_purchase"?{
              ingredientId:selected,quantity,unit:edit!.unit,costCents:cents,date:edit!.date,
              ...(p.source==="receipt_chat"?{receiptVendor:edit!.receiptVendor.trim(),receiptTotalCents}:{})
            }:{})
          })});
        const result=await response.json() as {proposal?:ProposalView;state?:string;error?:string};
        if(result.proposal)setValue(result.proposal);
        if(!response.ok)setError(true);
        if(action==="edit_purchase"&&response.ok)setPurchaseDraft(null);
      }catch{setError(true);}finally{setBusy(false);}
    };
    const amount=(new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(p.quantity)+" "+p.unit);
    return <section dir={locale==="ar"?"rtl":"ltr"} className="rounded-2xl border border-line bg-surface p-4 text-ink">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="text-xl font-bold">{p.name}</h3>
        <span className="rounded-full bg-surface2 px-3 py-1 text-[17px]">{label}</span></div>
      {!p.ingredientId&&<p className="mt-2 text-[17px] text-neg">{copy.newItem}</p>}
      <p className="mt-2 text-[17px]">{amount+" · "+p.date}</p>
      {p.costCents!==null&&<p className="mt-2 text-[17px]">{money(p.costCents)}</p>}
      {p.source==="receipt_chat"&&<p className="mt-2 text-[17px]">
        {copy.receiptVendor+": "+(p.receiptVendor??copy.receiptIncomplete)+" · "+
          copy.receiptTotal+": "+(p.receiptTotalCents?money(p.receiptTotalCents):copy.receiptIncomplete)}
      </p>}
      {!receiptComplete&&<p role="alert" className="mt-2 text-[17px] text-neg">{copy.receiptIncomplete}</p>}
      {purchaseDraft&&<form className="mt-3 space-y-2" onSubmit={e=>{e.preventDefault();void submit("edit_purchase");}}>
        <label className="block text-[17px]">{copy.ingredient}<select className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
          value={purchaseDraft.ingredientId??""} onChange={e=>setPurchaseDraft(v=>v?{...v,ingredientId:e.target.value||null}:v)}>
          <option value="">{copy.newItem}</option>
          {(value.ingredientOptions??[]).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label className="block text-[17px]">{copy.quantity}<input type="text" inputMode="decimal" className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
          value={purchaseDraft.quantity} onChange={e=>setPurchaseDraft(v=>v?{...v,quantity:e.target.value}:v)}/></label>
        <label className="block text-[17px]">{copy.unit}<input className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
          value={purchaseDraft.unit} onChange={e=>setPurchaseDraft(v=>v?{...v,unit:e.target.value}:v)}/></label>
        <label className="block text-[17px]">{copy.cost}<input type="text" inputMode="decimal" className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
          value={purchaseDraft.cost} onChange={e=>setPurchaseDraft(v=>v?{...v,cost:e.target.value}:v)}/></label>
        <label className="block text-[17px]">{copy.date}<input type="date" className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
          value={purchaseDraft.date} onChange={e=>setPurchaseDraft(v=>v?{...v,date:e.target.value}:v)}/></label>
        {p.source==="receipt_chat"&&<>
          <label className="block text-[17px]">{copy.receiptVendor}<input
            className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
            value={purchaseDraft.receiptVendor}
            onChange={e=>setPurchaseDraft(v=>v?{...v,receiptVendor:e.target.value}:v)}/></label>
          <label className="block text-[17px]">{copy.receiptTotal}<input type="text" inputMode="decimal"
            className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
            value={purchaseDraft.receiptTotal}
            onChange={e=>setPurchaseDraft(v=>v?{...v,receiptTotal:e.target.value}:v)}/></label>
        </>}
        <button type="submit" disabled={busy} className={button+" bg-accent text-on-accent"}>{copy.save}</button>
        <button type="button" disabled={busy} className={button} onClick={()=>setPurchaseDraft(null)}>{copy.cancel}</button>
      </form>}
      {(pending||canRetry)&&!purchaseDraft&&<div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy||!p.ingredientId||!receiptComplete} className={button+" bg-accent text-on-accent"}
          onClick={()=>void submit("approve")}>{canRetry?copy.retry:copy.approve}</button>
        {pending&&<button type="button" disabled={busy} className={button} onClick={()=>setPurchaseDraft({
          ingredientId:p.ingredientId,quantity:String(p.quantity),unit:p.unit,
          cost:p.costCents===null?"":String(p.costCents/100),date:p.date,
          receiptVendor:p.receiptVendor??"",receiptTotal:p.receiptTotalCents?String(p.receiptTotalCents/100):""
        })}>{copy.edit}</button>}
        {pending&&<button type="button" disabled={busy} className={button}
          onClick={()=>void submit("cancel")}>{copy.skip}</button>}
      </div>}
      {error&&<p role="alert" className="mt-3 text-[17px] text-neg">{copy.failed}</p>}
    </section>;
  }
  if(staff){
    const statuses:Record<string,string>={pending:staffCopy.pending,applying:staffCopy.applying,
      applied:staffCopy.applied,cancelled:staffCopy.cancelled,stale:staffCopy.stale,
      failed:staffCopy.stale,conflict:staffCopy.stale};
    const pending=value.state==="pending"&&!busy;
    const retry=value.state==="conflict"&&!busy;
    const button="min-h-12 min-w-12 rounded-xl px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
    return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={staffCopy.title}
      className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xl font-bold">{staffCopy.title}</h3>
        <span role="status" className="rounded-full bg-surface2 px-3 py-1 text-sm font-bold">
          {statuses[value.state]??staffCopy.failed}
        </span>
      </div>
      {value.subjectName&&<p className="mt-2 break-words text-lg font-bold">{value.subjectName}</p>}
      <p className="mt-2 text-[17px] text-ink-muted">{staffCopy.reviewNotice}</p>
      <BeforeAfterRows rows={value.preview??[]} locale={locale} currency={value.currency??"USD"}/>
      {value.capabilityId?.startsWith("olivia.staff_propose_send_schedule.v")===true&&value.state!=="applied"&&
        <p className="mt-3 text-[17px]">{staffCopy.preparedOnly}</p>}
      {value.state==="applied"&&(
        value.capabilityId?.startsWith("olivia.staff_propose_schedule.v")===true||
        value.capabilityId?.startsWith("olivia.staff_propose_send_schedule.v")===true)&&
        <><p className="mt-3 text-[17px]">{scheduleApprovalReply(locale)}</p><OwnerScheduleSendPanel key={proposalId} proposalId={proposalId} locale={locale}/></>}

      {(pending||retry)&&<div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={button+" bg-accent text-on-accent"}
          onClick={()=>void invoke("approve")}>{retry?staffCopy.retry:staffCopy.approve}</button>
        {pending&&<button type="button" disabled={busy} className={button+" border border-line"}
          onClick={()=>void invoke("cancel")}>{staffCopy.decline}</button>}
      </div>}
      {["stale","conflict","failed"].includes(value.state)&&<p role="alert" className="mt-3 text-neg">{staffCopy.staleDetails}</p>}
      {error&&<p role="alert" className="mt-3 text-neg">{staffCopy.error}</p>}
    </section>;
  }
  const rows:ApprovalPreviewRow[]=value.preview?.length?value.preview:((value.oldPriceCents!=null&&value.newPriceCents!=null)?diffFields([{field:"price",label:"Price",value:{kind:"money",cents:value.oldPriceCents}}],[{field:"price",label:"Price",value:{kind:"money",cents:value.newPriceCents}}]):[]);
  const localizedRows=rows;
  const pending=value.state==="pending"&&!busy;
  const statuses={...copy.states,...(experiment?{manual_pending:copy.manualPending}:{}),
    ...(goal?{tracking:dict[locale].Goals.cardTracking}:{})} as Record<string,string>;
  const button="min-h-12 min-w-12 rounded-xl px-4 text-[17px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
  return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={copy.title}
    className="w-full min-w-0 max-w-2xl rounded-[22px] border border-line bg-surface p-4 text-ink shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[15px] font-semibold text-ink-muted">{copy.proposedBy}</p>
      <span role="status" className="rounded-full bg-surface2 px-3 py-1 text-sm font-bold">{statuses[value.state]??copy.states.failed}</span>
    </div>
    <h3 className="mt-2 break-words text-xl font-bold">{value.productName}</h3>
    <BeforeAfterRows rows={localizedRows} locale={locale} currency={value.currency??"USD"}/>
    {value.editedByOwner&&<p className="mt-2">{copy.editedByYou}</p>}
    {experiment&&value.state==="manual_pending"&&<p className="mt-2 text-[17px]">{copy.manualInstructions}</p>}
    {value.state==="stale"&&<p className="mt-2">{copy.stale} {value.currentPriceCents!=null?money(value.currentPriceCents):""}</p>}
    {["failed","conflict","stale"].includes(value.state)&&<p className="mt-2">{copy.stale}</p>}
    {pending&&<div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={button+" bg-accent text-on-accent"}
        onClick={()=>void invoke("approve")}>{copy.approve}</button>
      {!experiment&&!goal&&<button type="button" disabled={busy} className={button+" border border-line"}
        onClick={()=>{setEditing(x=>!x);setPrice(priceEditString(value.newPriceCents!));}}>{copy.edit}</button>}
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
