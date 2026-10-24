"use client";
import {useEffect,useState} from "react";
import {useLocale,useTranslations} from "next-intl";
import {statusSchema} from "@/lib/pos/toast/statusSchema";
import type {z} from "zod";
type Snapshot=z.infer<typeof statusSchema>;
const dateShift=(d:string,days:number)=>new Date(Date.parse(d+"T12:00:00Z")+days*86400000).toISOString().slice(0,10);
function localDate(zone:string){return new Intl.DateTimeFormat("en-CA",{timeZone:zone,
 year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}
export default function ToastOwnerDashboard({businessId,currency}:{businessId:string;currency:string}){
 const t=useTranslations("ToastConnect");const locale=useLocale();
 const [data,setData]=useState<Snapshot|null>(null),[bad,setBad]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [start,setStart]=useState(""),[note,setNote]=useState("");
 const [selected,setSelected]=useState<string[]>([]);
 const money=new Intl.NumberFormat(locale,{style:"currency",currency});
 const number=new Intl.NumberFormat(locale);
 const fmt=(n:number|null)=>n==null?t("noAmount"):money.format(n/100);
 const day=(d:string)=>new Intl.DateTimeFormat(locale,{timeZone:"UTC",dateStyle:"medium"})
  .format(new Date(d+"T12:00:00Z"));
 async function load(){
  const response=await fetch("/api/pos/toast/status?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
  if(!response.ok)throw Error("unavailable");
  const parsed=statusSchema.safeParse(await response.json());
  if(!parsed.success)throw Error("invalid_status");
  setData(parsed.data);setBad(false);
  if(!start)setStart(parsed.data.startDate??dateShift(localDate(parsed.data.timeZone),-84));
 }
 useEffect(()=>{let active=true;const refresh=async()=>{
  try{const response=await fetch("/api/pos/toast/status?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
   if(!response.ok)throw Error("unavailable");
   const parsed=statusSchema.safeParse(await response.json());
   if(!parsed.success)throw Error("invalid_status");
   if(active){setData(parsed.data);setBad(false);setStart(old=>old||parsed.data.startDate||
    dateShift(localDate(parsed.data.timeZone),-84));}
  }catch{if(active){setData(null);setBad(true);}}
 };void refresh();return()=>{active=false;};},[businessId]);
 async function post(url:string,payload:unknown){
  if(busy)return false;setBusy(true);setMessage("");
  try{const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({businessId,...(payload as object)})});
   if(!response.ok)throw Error("unavailable");
   await load();setMessage(t("ownerSaved"));return true;
  }catch{setMessage(t("ownerError"));return false;}finally{setBusy(false);}
 }
 async function backfill(){
  if(!data)return;const end=dateShift(localDate(data.timeZone),-1);
  if(start>end||start<"2015-12-02"){setMessage(t("ownerInvalidDate"));return;}
  // Queue bounded slices; a range longer than 400 days is never sent to SQL.
  setBusy(true);setMessage("");
  try{for(let from=start;from<=end;){
   const to=dateShift(from,399)<end?dateShift(from,399):end;
   const r=await fetch("/api/pos/toast/backfill",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({businessId,from,to})});
   if(!r.ok)throw Error("unavailable");from=dateShift(to,1);
  }await load();setMessage(t("ownerQueued"));
  }catch{setMessage(t("ownerError"));}finally{setBusy(false);}
 }
 if(bad)return <p role="alert" className="rounded-card-lg bg-warn-tint p-4 text-warn">{t("ownerStatusUnavailable")}</p>;
 if(!data)return <p role="status" className="text-ink-muted">{t("pending")}</p>;
 const yesterday=dateShift(localDate(data.timeZone),-1);
 const relative=data.lastGoodSyncAt?new Intl.RelativeTimeFormat(locale,{numeric:"auto"}).format(
  -Math.max(0,Math.round((Date.now()-Date.parse(data.lastGoodSyncAt))/3600000)),"hour"):t("noSyncYet");
 return <div className="flex flex-col gap-4" dir={locale==="ar"?"rtl":"ltr"}>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold text-ink">{t("ownerImportFrom")}</h2>
   <p className="my-2 text-ink-muted">{data.startDate?day(data.startDate):t("ownerNoStart")}</p>
   <input aria-label={t("ownerImportFrom")} className="min-h-12 w-full rounded-xl border border-line bg-card p-3"
    type="date" value={start} max={yesterday} onChange={e=>setStart(e.target.value)}/>
   <button disabled={busy||!start||start>yesterday} onClick={()=>void backfill()}
    className="mt-3 min-h-12 w-full rounded-full bg-accent px-4 text-on-accent disabled:opacity-40">
    {t("ownerStartImport")}</button>
  </section>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold text-ink">{t("ownerSyncStatus")}</h2>
   <p className="mt-2 text-ink-muted">{t("ownerLastSync",{time:relative})}</p>
   {data.stale&&<p className="mt-2 text-warn">{t("ownerStale")}</p>}
   {data.backfill.daysTotal>0&&<>
    <p>{t("ownerProgress",{done:number.format(data.backfill.daysDone),total:number.format(data.backfill.daysTotal)})}</p>
    <progress className="w-full" value={data.backfill.daysDone} max={data.backfill.daysTotal}/>
   </>}
   {data.backfill.resumeAt&&<p className="text-warn">{t("ownerPaused",{time:new Date(data.backfill.resumeAt).toLocaleString(locale)})}</p>}
   {data.failedRuns>0&&<button disabled={busy} className="mt-3 min-h-12 rounded-full border border-line px-5"
     onClick={()=>void post("/api/pos/toast/retry",{})}>{t("ownerTryAgain")}</button>}
  </section>
  {data.firstImportCheck==="due"&&<section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerFirstCheck")}</h2>
   <p className="text-ink-muted">{t("ownerFirstCheckHint")}</p>
   <div className="my-3 flex flex-col gap-2">
    {data.recent.slice(0,7).map(row=><label key={row.date}
     className="flex min-h-12 items-center gap-3 border-b border-line py-2">
      <input type="checkbox" checked={selected.includes(row.date)} onChange={e=>setSelected(old=>
       e.target.checked?[...old,row.date]:old.filter(x=>x!==row.date))}/>
      <span className="flex-1"><bdi>{day(row.date)}</bdi></span>
      <span><bdi>{fmt(row.netSalesCents)}</bdi></span>
     </label>)}
   </div>
   {!data.analytics.verified&&<p className="text-ink-muted">{t("ownerCompareWeb")}</p>}
   <textarea aria-label={t("ownerNote")} placeholder={t("ownerNote")} value={note}
    onChange={e=>setNote(e.target.value)} maxLength={2000}
    className="mt-3 min-h-20 w-full rounded-xl border border-line p-3"/>
   <div className="mt-3 flex flex-wrap gap-2">
    <button disabled={busy} className="min-h-12 rounded-full bg-good-tint px-5 text-good"
     onClick={()=>void post("/api/pos/toast/first-import-check",{answer:"looks_right",flaggedDates:[]})}>{t("ownerLooksRight")}</button>
    <button disabled={busy||!selected.length} className="min-h-12 rounded-full bg-warn-tint px-5 text-warn"
     onClick={()=>void post("/api/pos/toast/first-import-check",{answer:"something_off",flaggedDates:selected,note})}>{t("ownerSomethingOff")}</button>
   </div>
  </section>}
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerNeedsLook")}</h2>
   {!data.needsLook.length&&<p className="text-ink-muted">{t("ownerNoIssues")}</p>}
   {data.needsLook.map((row,i)=><div key={row.restaurantGuid+row.date+i}
    className="border-b border-line py-4">
    <p className="font-semibold"><bdi>{day(row.date)}</bdi></p>
    <p className="text-ink-muted">{t("ownerOurs")}: <bdi>{fmt(row.oursCents)}</bdi> · {t("ownerToast")}: <bdi>{fmt(row.toastCents)}</bdi></p>
    <p>{t("ownerDifference")}: <bdi>{fmt(row.deltaCents)}</bdi></p>
    <p className="text-warn">{t("ownerReviewReason")}: {row.reason.replaceAll("_"," ")}</p>
    <div className="mt-2 flex flex-wrap gap-2">
     <button disabled={busy||row.date>yesterday} className="min-h-12 rounded-full border border-line px-4"
      onClick={()=>void post("/api/pos/toast/backfill",{from:row.date,to:row.date})}>{t("ownerRepull")}</button>
     <button disabled={busy} className="min-h-12 rounded-full border border-line px-4"
      onClick={()=>void post("/api/pos/toast/day-flag",{restaurantGuid:row.restaurantGuid,date:row.date,
       action:row.reason==="owner_flag"?"clear":"flag",note})}>{t(row.reason==="owner_flag"?"ownerClearFlag":"ownerFlagDay")}</button>
    </div>
   </div>)}
  </section>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerRecent")}</h2>
   {data.recent.map(row=><div key={row.date} className="flex flex-wrap items-center gap-2 border-b border-line py-3">
    <span className="min-w-24 flex-1"><bdi>{day(row.date)}</bdi></span>
    <span><bdi>{fmt(row.netSalesCents)}</bdi></span>
    <span>{t("ownerOrders",{count:number.format(row.orders??0)})}</span>
    <span className="text-ink-muted">{t("ownerState_"+row.status)}</span>
   </div>)}
  </section>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerAnalytics")}</h2>
   <p className="text-ink-muted">{t("ownerAnalyticsNote")}</p>
   <p className="mt-2 font-semibold">{data.analytics.verified?t("verified"):t("notConnected")}</p>
  </section>
  {message&&<p role="status" className="rounded-xl bg-card p-3">{message}</p>}
 </div>;
}
