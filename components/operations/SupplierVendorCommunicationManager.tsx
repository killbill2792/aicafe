"use client";
import {useEffect,useState,type FormEvent} from "react";
import en from "@/messages/en.json";
const field="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface p-3 text-[17px] text-ink";
type Contact={id:string;supplier_id:string;channel:string;email:string|null;
 details:string|null;verified_at:string;revoked_at:string|null};
type Supplier={id:string;name:string;contact:Contact|null};
type Order={id:string;supplierId:string;supplierName:string;status:string;approvedAt:string};
type Data={suppliers:Supplier[];orders:Order[]};
const options=[
 ["gmail","gmail"],["phone","phone"],["portal","portal"],["in_person","inPerson"],["other","other"]
] as const;
/** The owner is the source authority for vendor contacts and phone/portal
 * negotiation outcomes. This screen never performs supplier sends. */
export default function SupplierVendorCommunicationManager(){
 const copy=en.SupplierVendorCommunication;
 const [data,setData]=useState<Data>({suppliers:[],orders:[]});
 const [supplierId,setSupplierId]=useState("");
 const [channel,setChannel]=useState<(typeof options)[number][0]>("gmail");
 const [email,setEmail]=useState("");
 const [details,setDetails]=useState("");
 const [orderId,setOrderId]=useState("");
 const [outcome,setOutcome]=useState("unknown");
 const [note,setNote]=useState("");
 const [reportChannel,setReportChannel]=useState("gmail");
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);
 const [loaded,setLoaded]=useState(false);
 const load=async()=>{
  const response=await fetch("/api/ai/suppliers/contacts",{cache:"no-store"});
  if(!response.ok)throw new Error("supplier_contacts_unavailable");
  const next=await response.json() as Data;
  setData(next);setLoaded(true);
  setSupplierId(before=>before||next.suppliers[0]?.id||"");
  setOrderId(before=>before||next.orders.find(o=>o.status==="approved_for_ordering")?.id||"");
 };
 useEffect(()=>{let active=true;
  void fetch("/api/ai/suppliers/contacts",{cache:"no-store"})
   .then(async r=>{if(!r.ok)throw new Error();return r.json() as Promise<Data>})
   .then(next=>{if(active){setData(next);setLoaded(true);
    setSupplierId(next.suppliers[0]?.id||"");
    setOrderId(next.orders.find(o=>o.status==="approved_for_ordering")?.id||"");}})
   .catch(()=>{if(active)setMessage(copy.error);});
  return ()=>{active=false};
 },[copy.error]);
 const contact=data.suppliers.find(s=>s.id===supplierId)?.contact;
 const chooseSupplier=(id:string)=>{
  const selected=data.suppliers.find(s=>s.id===id)?.contact;
  setSupplierId(id);
  setChannel(selected?.channel==="phone"||selected?.channel==="portal"||
   selected?.channel==="in_person"||selected?.channel==="other"?selected.channel:"gmail");
  setEmail(selected?.email??"");setDetails(selected?.details??"");
 };
 const post=async(input:Record<string,unknown>)=>{
  setBusy(true);setMessage("");
  try{
   const response=await fetch("/api/ai/suppliers/contacts",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(input)
   });
   if(!response.ok)throw new Error("supplier_contact_save_failed");
   await load();
   setMessage(input.action==="report_outcome"?copy.outcomeSaved:
    input.action==="revoke_contact"?copy.revoked:copy.saved);
  }catch{setMessage(copy.error)}finally{setBusy(false)}
 };
 const verify=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  if(!supplierId||busy||(channel==="gmail"&&!email.trim()))return;
  void post({action:"verify_contact",supplierId,channel,
   email:channel==="gmail"?email.trim():null,details:details.trim()||null});
 };
 const report=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  if(!orderId||!note.trim()||busy)return;
  void post({action:"report_outcome",purchaseOrderId:orderId,channel:reportChannel,
   outcome,note:note.trim()});
 };
 return <section className="rounded-2xl bg-card p-4">
  <h2 className="font-headline text-2xl font-bold text-ink">{copy.title}</h2>
  <p className="mt-2 text-[17px] text-ink-muted">{copy.intro}</p>
  <form className="mt-4 grid gap-3" onSubmit={verify}>
   <label className="text-[17px] font-semibold text-ink">{copy.supplier}
    <select aria-label={copy.supplier} className={field} value={supplierId}
     onChange={event=>chooseSupplier(event.target.value)} required>
     {!loaded&&<option value="">...</option>}
     {data.suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
   </label>
   <label className="text-[17px] font-semibold text-ink">{copy.channel}
    <select aria-label={copy.channel} className={field} value={channel}
     onChange={event=>setChannel(event.target.value as typeof channel)}>
     {options.map(([value,key])=><option key={value} value={value}>{copy[key]}</option>)}
    </select>
   </label>
   {channel==="gmail"&&<label className="text-[17px] font-semibold text-ink">{copy.email}
    <input className={field} type="email" required maxLength={320} value={email}
     onChange={event=>setEmail(event.target.value)}/>
   </label>}
   <label className="text-[17px] font-semibold text-ink">{copy.details}
    <textarea className={field} maxLength={600} value={details}
     onChange={event=>setDetails(event.target.value)}/>
   </label>
   <div className="flex flex-wrap gap-3">
    <button disabled={busy||!supplierId} className="min-h-12 rounded-full bg-ink px-5 text-paper disabled:opacity-50">
     {copy.verify}</button>
    {contact&&!contact.revoked_at&&<button type="button" disabled={busy}
     className="min-h-12 rounded-full border border-line px-5 text-ink disabled:opacity-50"
     onClick={()=>void post({action:"revoke_contact",supplierId})}>{copy.revoke}</button>}
   </div>
  </form>
  <h3 className="mt-6 text-lg font-bold text-ink">{copy.orders}</h3>
  <form className="mt-3 grid gap-3" onSubmit={report}>
   <label className="text-[17px] font-semibold text-ink">{copy.order}
    <select className={field} required value={orderId}
     onChange={event=>setOrderId(event.target.value)}>
     {!data.orders.length&&<option value="">{copy.pending}</option>}
     {data.orders.map(order=><option value={order.id} key={order.id}>
      {order.supplierName} · {order.id.slice(0,8)} · {order.status}</option>)}
    </select>
   </label>
   <label className="text-[17px] font-semibold text-ink">{copy.channel}
    <select aria-label={copy.channel} className={field} value={reportChannel}
     onChange={event=>setReportChannel(event.target.value)}>
     {options.map(([value,key])=><option key={value} value={value}>{copy[key]}</option>)}
    </select>
   </label>
   <label className="text-[17px] font-semibold text-ink">{copy.outcome}
    <select className={field} value={outcome} onChange={event=>setOutcome(event.target.value)}>
     <option value="unknown">{copy.unknown}</option>
     <option value="not_contacted">{copy.notContacted}</option>
     <option value="supplier_contacted">{copy.contacted}</option>
     <option value="supplier_acknowledged">{copy.acknowledged}</option>
     <option value="supplier_accepted">{copy.accepted}</option>
     <option value="supplier_declined">{copy.declined}</option>
    </select>
   </label>
   <label className="text-[17px] font-semibold text-ink">{copy.note}
    <textarea className={field} required maxLength={1000} value={note}
     onChange={event=>setNote(event.target.value)}/>
   </label>
   <button className="min-h-12 rounded-full bg-ink px-5 text-paper disabled:opacity-50"
    disabled={busy||!orderId||!note.trim()}>{copy.saveOutcome}</button>
  </form>
  <p className="mt-3 text-[17px] text-ink-muted">{copy.status}</p>
  <p role="status" aria-live="polite" className="mt-3 text-[17px] text-ink">{message}</p>
 </section>;
}
