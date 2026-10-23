"use client";
import {useEffect,useState} from "react";
import {composeScheduleLink,eligibleForChannel,type OwnerChannel} from "@/lib/calc/scheduling/ownerDeliveryLinks";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
type Locale="en"|"es"|"ar";
type Recipient={id:string;name:string;phone:string|null;optedIn:boolean;preferredChannel:OwnerChannel;
  message:string;ledgerStatus:"prepared"|"sent_by_owner"|null;lastChannel:OwnerChannel|null;sentAt:string|null};
type Data={source:{proposalId?:string;planRevisionId?:string};week:string;recipients:Recipient[]};
type Props={week?:string;proposalId?:string;locale:Locale};
const copy={en,es,ar};
export default function OwnerScheduleSendPanel({week,proposalId,locale}:Props){
 const t=copy[locale].OwnerScheduleDelivery;
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),
 [error,setError]=useState(""),[notApproved,setNotApproved]=useState(false);
 const [busy,setBusy]=useState<string|null>(null);
 const [batch,setBatch]=useState<string[]>([]),[position,setPosition]=useState(0);
 const endpoint="/api/staff/schedule-delivery";
 const params=new URLSearchParams({...proposalId?{proposalId}:{week:week??""},locale}).toString();
 useEffect(()=>{
  let alive=true;
  void fetch(endpoint+"?"+params,{credentials:"same-origin",cache:"no-store"})
   .then(async response=>{
     if(response.status===409){if(alive)setNotApproved(true);return null;}
     if(!response.ok)throw Error("load");
     return response.json() as Promise<Data>;
   })
   .then(rows=>{if(alive&&rows){setData(rows);setNotApproved(false);}})
   .catch(()=>{if(alive)setError("load");})
   .finally(()=>{if(alive)setLoading(false);});
  return ()=>{alive=false;};
 },[params]);
 async function preference(person:Recipient,channel:OwnerChannel){
  setBusy(person.id);setError("");
  try{
   const result=await fetch(endpoint,{method:"PATCH",credentials:"same-origin",
     headers:{"content-type":"application/json"},body:JSON.stringify({employeeId:person.id,channel})});
   if(!result.ok)throw Error("preference");
   setData(value=>value?{...value,recipients:value.recipients.map(row=>row.id===person.id?
     {...row,preferredChannel:channel}:row)}:value);
  }catch{setError("save");}finally{setBusy(null);}
 }
 async function record(person:Recipient,channel:OwnerChannel){
  // This is the owner clicking to open an external composer, NOT a delivery receipt.
  setBusy(person.id);setError("");
  try{
   const result=await fetch(endpoint,{method:"POST",credentials:"same-origin",
     headers:{"content-type":"application/json"},
     body:JSON.stringify({...proposalId?{proposalId}:{week},employeeId:person.id,channel})});
   if(!result.ok)throw Error("ledger");
   const resultJson=await result.json() as {state:string;channel:OwnerChannel;at?:string};
   setData(value=>value?{...value,recipients:value.recipients.map(row=>row.id===person.id?
     {...row,ledgerStatus:"sent_by_owner",lastChannel:resultJson.channel,sentAt:resultJson.at??new Date().toISOString()}:row)}:value);
  }catch{setError("ledger");}finally{setBusy(null);}
 }
 const method=(person:Recipient,channel:OwnerChannel)=>{
  const status=eligibleForChannel(person.phone,person.optedIn,channel);
  if(status!=="ready")return <span className="text-sm text-ink-muted">{status==="no_phone"?t.noPhone:t.noOptIn}</span>;
  const isIOS=typeof navigator!=="undefined"&&/iPad|iPhone|iPod/.test(navigator.userAgent);
  const href=composeScheduleLink(person.phone!,person.message,channel,isIOS);
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-12 items-center justify-center rounded-xl border border-accent px-4 text-[17px] font-semibold text-accent-text"
    onClick={()=>{
      void record(person,channel);
      if(batch.length&&batch[position]===person.id)setPosition(index=>index+1);
    }}>{channel==="whatsapp"?t.sendWhatsApp:t.sendSms}</a>;
 };
 const eligible=data?.recipients.filter(row=>row.ledgerStatus!=="sent_by_owner"&&(
  eligibleForChannel(row.phone,row.optedIn,row.preferredChannel)==="ready"||
  eligibleForChannel(row.phone,row.optedIn,row.preferredChannel==="sms"?"whatsapp":"sms")==="ready"
 ))??[];
 const next=batch.length&&position<batch.length?data?.recipients.find(p=>p.id===batch[position]):null;
 return <section dir={locale==="ar"?"rtl":"ltr"} aria-label={t.heading}
   className="mt-4 space-y-3 rounded-2xl border border-line bg-surface p-4">
  <h3 className="text-xl font-bold">{t.heading}</h3>
  <p className="text-[17px] text-ink-muted">{t.manualNotice}</p>
  {loading&&<p role="status">{t.loading}</p>}
  {notApproved&&<p role="status">{t.notApproved}</p>}
  {error&&<p role="alert" className="text-neg">{error==="ledger"?t.ledgerError:error==="save"?t.preferenceError:t.loadError}</p>}
  {data&&<>
   <p className="text-sm font-semibold">{t.week}: {data.week}</p>
   {data.recipients.length===0&&<p>{t.noShifts}</p>}
   <div className="flex flex-wrap gap-3">
    {eligible.length>0&&<button type="button" onClick={()=>{setBatch(eligible.map(p=>p.id));setPosition(0);}}
      className="min-h-12 rounded-xl bg-accent px-4 font-semibold text-on-accent">{t.sendAll}</button>}
   </div>
   {batch.length>0&&<div className="rounded-xl border border-accent p-3" role="status">
    {next?<><p className="font-semibold">{t.next}: {next.name} ({position+1}/{batch.length})</p>
      <div className="mt-2 flex flex-wrap gap-2">
       {method(next,next.preferredChannel)}
       {method(next,next.preferredChannel==="sms"?"whatsapp":"sms")}
       <button type="button" className="min-h-12 px-3 underline" onClick={()=>setPosition(x=>x+1)}>{t.skip}</button>
      </div></>:<p>{t.listDone}</p>}
   </div>}
   {data.recipients.map(person=><article key={person.id} className="rounded-xl border border-line p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
     <h4 className="font-bold text-[17px]">{person.name}</h4>
     <label className="text-sm font-semibold">{t.preferred}
      <select aria-label={t.preferred+" "+person.name} value={person.preferredChannel}
       onChange={event=>void preference(person,event.target.value as OwnerChannel)}
       disabled={busy===person.id} className="ms-2 min-h-12 rounded-lg border border-line bg-surface p-2">
       <option value="whatsapp">{t.whatsApp}</option><option value="sms">{t.sms}</option>
      </select></label>
    </div>
    <p className="my-2 whitespace-pre-wrap break-words text-[17px]">{person.message}</p>
    {person.ledgerStatus==="sent_by_owner"&&<p className="mb-2 text-sm text-ink-muted" role="status">
       {t.opened} · {person.lastChannel==="sms"?t.sms:t.whatsApp}{person.sentAt?" · "+person.sentAt:""}
     </p>}
    <div className="flex flex-wrap items-center gap-2">
     {method(person,person.preferredChannel)}
     {method(person,person.preferredChannel==="sms"?"whatsapp":"sms")}
    </div>
   </article>)}
  </>}
 </section>;
}
