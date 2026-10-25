"use client";
import {useRef,useState} from "react";
import {useLocale,useTranslations} from "next-intl";
import {z} from "zod";
import {parseToastNumber,toastSummaryDraft,type ToastSummaryDraft} from "@/lib/calc/toastSummaryInput";
type Day={date:string;restaurantGuid:string;oursCents:number|null};
type Draft=ToastSummaryDraft&{restaurantGuid:string;source:"typed"|"photo"|"csv"};
export default function ToastSummaryComparison({businessId,days,currency,onSaved,restaurantNames={}}:{businessId:string;days:Day[];currency:string;onSaved:()=>Promise<void>;restaurantNames?:Record<string,string>}){
 const t=useTranslations("ToastConnect"),locale=useLocale();
 const [drafts,setDrafts]=useState<Draft[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const lock=useRef(false);
 const money=new Intl.NumberFormat(locale,{style:"currency",currency});
 const [target,setTarget]=useState(0);
 const selected=days[target];
 const locationName=(guid:string)=>restaurantNames[guid]||t("summaryLocation",{number:new Set(days.map(d=>d.restaurantGuid)).size===1?1:[...new Set(days.map(d=>d.restaurantGuid))].indexOf(guid)+1});
 async function upload(file:File|undefined){
  if(!file||!selected||lock.current)return;
  lock.current=true;setBusy(true);setMessage("");
  try{
   if(file.size>5000000)throw Error();
   const source=file.name.toLowerCase().endsWith(".csv")?"csv":"photo";
   const content=source==="csv"?await file.text():await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);
   });
   const response=await fetch("/api/pos/toast/summary/preview",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({businessId,restaurantGuid:selected.restaurantGuid,date:selected.date,locale,source,content})});
   if(!response.ok)throw Error();
   const parsed=z.object({days:z.array(toastSummaryDraft).min(1).max(31)}).parse(await response.json());
   setDrafts(parsed.days.map(d=>({...d,restaurantGuid:selected.restaurantGuid,source})));setMessage(t("summaryConfirmHint"));
  }catch{setMessage(t("summaryReadError"));}finally{lock.current=false;setBusy(false);}
 }
 async function save(draft:Draft){
  if(lock.current)return;lock.current=true;setBusy(true);setMessage("");
  try{
   const response=await fetch("/api/pos/toast/summary",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({businessId,...draft})});
   if(!response.ok)throw Error();
   setDrafts(old=>old.filter(d=>d!==draft));setMessage(t("ownerSaved"));await onSaved();
  }catch{setMessage(t("ownerError"));}finally{lock.current=false;setBusy(false);}
 }
 function typed(form:HTMLFormElement,day:Day){
  try{
   const values=new FormData(form),read=(key:string,money=true)=>parseToastNumber(String(values.get(key)??""),locale,money);
   const draft=toastSummaryDraft.parse({date:day.date,netSalesCents:read("net"),ordersCount:read("orders",false),
    discountsCents:read("discounts"),refundsCents:read("refunds"),voidsCount:read("voids",false)});
   setDrafts([{...draft,restaurantGuid:day.restaurantGuid,source:"typed"}]);setMessage(t("summaryConfirmHint"));
  }catch{setMessage(t("summaryNumberError"));}
 }
 return <section className="rounded-card-lg bg-card p-5 text-[17px]" dir={locale==="ar"?"rtl":"ltr"}>
  <h2 className="text-xl font-bold">{t("summaryTitle")}</h2><p className="text-muted">{t("summaryOptional")}</p>
  {days.map(day=><details key={day.restaurantGuid+day.date} className="border-b border-line py-2">
   <summary className="min-h-12 cursor-pointer py-3">{t("summaryCompareDay",{date:day.date})}</summary>
   <p className="text-muted"><bdi>{locationName(day.restaurantGuid)}</bdi></p>
   <p>{t("summaryImported",{amount:day.oursCents==null?t("noAmount"):money.format(day.oursCents/100)})}</p>
   <form onSubmit={e=>{e.preventDefault();typed(e.currentTarget,day);}} className="flex flex-col gap-3">
    <label>{t("summaryNet")}<input required name="net" inputMode="decimal" className="min-h-12 w-full rounded-xl border border-line bg-surface p-3"/></label>
    <label>{t("summaryOrders")}<input name="orders" inputMode="numeric" className="min-h-12 w-full rounded-xl border border-line bg-surface p-3"/></label>
    <details><summary className="min-h-12 cursor-pointer py-3">{t("summaryOptionalFields")}</summary>
     {(["discounts","refunds","voids"] as const).map(key=><label key={key} className="block">{t("summary_"+key)}<input name={key} inputMode={key==="voids"?"numeric":"decimal"} className="min-h-12 w-full rounded-xl border border-line bg-surface p-3"/></label>)}
    </details>
    <button disabled={busy} className="min-h-12 rounded-full border border-line px-4">{t("summaryPreview")}</button>
   </form>
  </details>)}
  {days.length>0&&<div className="mt-4 flex flex-col gap-3">
   <label>{t("summaryReportLocation")}<select className="min-h-12 w-full rounded-xl border border-line bg-surface p-3" value={target} onChange={e=>setTarget(Number(e.target.value))}>
    {days.map((d,i)=><option key={d.restaurantGuid+d.date} value={i}>{d.date} · {locationName(d.restaurantGuid)}</option>)}
   </select></label>
   <p className="text-muted">{t("summaryFileHint")}</p>
   <label className="min-h-12 rounded-xl border border-line p-3">{t("summaryAddReport")}
    <input type="file" disabled={busy} accept="image/jpeg,image/png,image/webp,.csv" className="mt-2 block w-full" onChange={e=>{void upload(e.target.files?.[0]);e.target.value="";}}/>
   </label>
  </div>}
  {drafts.map((draft,i)=><div key={i} className="mt-4 rounded-xl border border-line p-4">
   <p className="font-semibold">{t("summaryConfirmHint")}</p><p><bdi>{locationName(draft.restaurantGuid)}</bdi></p>
   <label>{t("summaryDate")}<input type="date" value={draft.date} className="min-h-12 w-full rounded-xl border border-line bg-surface p-3"
    onChange={e=>setDrafts(old=>old.map((d,n)=>n===i?{...d,date:e.target.value}:d))}/></label>
   {(["netSalesCents","ordersCount","discountsCents","refundsCents","voidsCount"] as const).map(key=><p key={key}>{t("summaryField_"+key)}: <bdi>{draft[key]==null?t("noAmount"):key.endsWith("Cents")?money.format(draft[key]!/100):new Intl.NumberFormat(locale).format(draft[key]!)}</bdi></p>)}
   <button disabled={busy} className="mt-3 min-h-12 rounded-full bg-accent px-5 text-on-accent" onClick={()=>void save(draft)}>{t("summaryConfirmSave")}</button>
   <button disabled={busy} className="ms-2 mt-3 min-h-12 rounded-full border border-line px-5" onClick={()=>setDrafts(old=>old.filter((_,n)=>n!==i))}>{t("summaryDiscard")}</button>
  </div>)}
  {message&&<p role="status" className="mt-3">{message}</p>}
 </section>;
}
