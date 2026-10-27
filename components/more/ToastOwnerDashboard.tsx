"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useLocale,useTranslations} from "next-intl";
import ToastSummaryComparison from "./ToastSummaryComparison";
import {statusSchema} from "@/lib/pos/toast/statusSchema";
import {subscribeToastConnectionChanges,createToastStatusRequestGate} from "./toastConnectionEvents";
import {canStartToastImport,canRepullToastDay,commitToastOwnerAction,queueToastBackfillChunks,PartialToastQueueError} from "./toastOwnerActionState";
import type {z} from "zod";
type Snapshot=z.infer<typeof statusSchema>;
const dateShift=(d:string,days:number)=>new Date(Date.parse(d+"T12:00:00Z")+days*86400000).toISOString().slice(0,10);
function localDate(zone:string,instant:number){return new Intl.DateTimeFormat("en-CA",{timeZone:zone,
 year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(instant));}
export default function ToastOwnerDashboard({businessId,currency}:{businessId:string;currency:string}){
 const t=useTranslations("ToastConnect");const locale=useLocale();
 const [data,setData]=useState<Snapshot|null>(null),[bad,setBad]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [start,setStart]=useState(""),[note,setNote]=useState("");
 const [selected,setSelected]=useState<string[]>([]);
 const [analytics,setAnalytics]=useState({apiUrl:"",managementGroupGuid:"",clientId:"",clientSecret:""});
 const [analyticsBusy,setAnalyticsBusy]=useState(false);
 const [lastLoadedAt,setLastLoadedAt]=useState<number|null>(null);
 const [reloadKey,setReloadKey]=useState(0);
 const statusGate=useRef(createToastStatusRequestGate());
 const money=new Intl.NumberFormat(locale,{style:"currency",currency});
 const number=new Intl.NumberFormat(locale);
 async function configureAnalytics(action:"connect"|"disconnect"){
  if(analyticsBusy)return;
  setAnalyticsBusy(true);setMessage("");
  try{
   await commitToastOwnerAction(async()=>{
    const url="/api/pos/toast/analytics"+(action==="disconnect"?"?businessId="+encodeURIComponent(businessId):"");
    const response=await fetch(url,{method:action==="disconnect"?"DELETE":"POST",
     headers:{"Content-Type":"application/json"},
     ...(action==="connect"?{body:JSON.stringify({businessId,...analytics})}:{})});
    if(!response.ok){const result=await response.json() as {error?:string};throw Error(result.error??"unavailable");}
    setAnalytics(old=>({...old,clientSecret:""}));
   },load);
   setMessage(t("ownerSaved"));
  }catch(error){const category=error instanceof Error?error.message:"unavailable";
   setMessage(t(category==="missing_permissions"?"analyticsErrorPermissions":category==="authentication"?"analyticsErrorAuthentication":category==="invalid_host"?"analyticsErrorHost":"ownerError"));
   void load().catch(()=>{});
  }finally{setAnalyticsBusy(false)}
 }
 const fmt=(n:number|null)=>n==null?t("noAmount"):money.format(n/100);
 const day=(d:string)=>new Intl.DateTimeFormat(locale,{timeZone:"UTC",dateStyle:"medium"})
  .format(new Date(d+"T12:00:00Z"));
 const load=useCallback(async()=>{
  const request=statusGate.current.begin();
  try{
   const response=await fetch("/api/pos/toast/status?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
   if(!response.ok)throw Error("unavailable");
   const parsed=statusSchema.safeParse(await response.json());
   if(!parsed.success)throw Error("invalid_status");
   if(!statusGate.current.isCurrent(request))return;
   setData(parsed.data);setBad(false);setLastLoadedAt(Date.now());
   setStart(old=>old||parsed.data.startDate||dateShift(localDate(parsed.data.timeZone,Date.now()),-84));
  }catch(error){
   // A stale request must not replace a newly verified connection with an error.
   if(!statusGate.current.isCurrent(request))return;
   setData(null);setBad(true);
   throw error;
  }
 },[businessId]);
 useEffect(()=>{
  const refresh=()=>{void load().catch(()=>{/* The retry control is now visible. */});};
  const gate=statusGate.current;
  const unsubscribe=subscribeToastConnectionChanges(window,refresh);
  refresh();
  return()=>{unsubscribe();gate.invalidate();};
 },[load,reloadKey]);
 async function post(url:string,payload:unknown){
  if(busy)return false;setBusy(true);setMessage("");
  try{
   await commitToastOwnerAction(async()=>{
    const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({businessId,...(payload as object)})});
    if(!response.ok)throw Error("unavailable");
   },load);
   setMessage(t("ownerSaved"));return true;
  }catch{setMessage(t("ownerError"));return false;}finally{setBusy(false);}
 }
 async function backfill(){
  if(!data)return;const end=dateShift(localDate(data.timeZone,Date.now()),-1);
  if(start>end||start<"2015-12-02"){setMessage(t("ownerInvalidDate"));return;}
  // Queue bounded slices; a range longer than 400 days is never sent to SQL.
  setBusy(true);setMessage("");
  try{
   await commitToastOwnerAction(async()=>{
    await queueToastBackfillChunks(start,end,async(from,to)=>{
     const r=await fetch("/api/pos/toast/backfill",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({businessId,from,to})});
     if(!r.ok)throw Error("unavailable");
    },dateShift);
   },load);
   setMessage(t("ownerQueued"));
  }catch(error){
   if(error instanceof PartialToastQueueError&&error.queuedChunks>0){
    setStart(error.resumeFrom);
    setMessage(t("ownerPartiallyQueued",{date:day(error.resumeFrom)}));
    // Prior chunks committed. An unavailable read must not erase that fact.
    void load().catch(()=>{});
   }else setMessage(t("ownerError"));
  }finally{setBusy(false);}
 }
 if(bad)return <section role="alert" className="rounded-card-lg bg-warn-tint p-4 text-warn">
  <p>{t("ownerStatusUnavailable")}</p>
  {message&&<p role="status" className="mt-2">{message}</p>}
  <button type="button" className="mt-3 min-h-12 rounded-full border border-warn px-5"
   onClick={()=>setReloadKey(k=>k+1)}>{t("ownerRefreshStatus")}</button>
 </section>;
 if(!data)return <p role="status" className="text-ink-muted">{t("pending")}</p>;
 const yesterday=lastLoadedAt?dateShift(localDate(data.timeZone,lastLoadedAt),-1):"";
 const relative=data.lastGoodSyncAt&&lastLoadedAt?new Intl.RelativeTimeFormat(locale,{numeric:"auto"}).format(
  -Math.max(0,Math.round((lastLoadedAt-Date.parse(data.lastGoodSyncAt))/3600000)),"hour"):t("noSyncYet");
 return <div className="flex flex-col gap-4 text-[17px]" dir={locale==="ar"?"rtl":"ltr"}>
  {data.missingLaborScope&&<section role="alert" className="rounded-card-lg border border-warn bg-warn-tint p-4 text-warn">
    {t("laborScopeMissing")}
  </section>}
  {data.missingMenuScope&&<section role="alert" className="rounded-card-lg border border-warn bg-warn-tint p-4 text-warn">
    {t("menuScopeMissing")}
  </section>}
  <section className="rounded-card-lg bg-card p-5">
   <p>{t(data.checkEvidence.mode==="official"?"checkModeOfficial":"checkModeInternal")}</p>
   {data.checkEvidence.compared>0&&<p className="mt-2">{t("summaryCompared",{count:data.checkEvidence.compared,matched:data.checkEvidence.matched})}</p>}
   {data.warnings.map((w,i)=><p key={i} className="mt-2 text-warn">{t("timeZoneWarning",{toast:w.toast_time_zone,cafe:w.reporting_time_zone})}</p>)}
   {data.rechecking.remaining>0&&<p className="mt-2">{t("closeoutRechecking",{done:number.format(data.rechecking.total-data.rechecking.remaining),total:number.format(data.rechecking.total)})}</p>}
  </section>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold text-ink">{t("ownerImportFrom")}</h2>
   <p className="my-2 text-ink-muted">{data.startDate?day(data.startDate):t("ownerNoStart")}</p>
   <input aria-label={t("ownerImportFrom")} className="min-h-12 w-full rounded-xl border border-line bg-card p-3"
    type="date" value={start} max={yesterday} onChange={e=>setStart(e.target.value)}/>
   {!data.importEnabled&&<p role="status" className="mt-2 text-warn">{t("ownerImportDisabled")}</p>}
   <button disabled={!canStartToastImport(data.importEnabled,busy,start,yesterday)} onClick={()=>void backfill()}
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
   {data.failedRuns>0&&<button disabled={busy||!data.importEnabled} className="mt-3 min-h-12 rounded-full border border-line px-5"
     onClick={()=>void post("/api/pos/toast/retry",{})}>{t("ownerTryAgain")}</button>}
  </section>
  {data.firstImportCheck==="due"&&<section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerFirstCheck")}</h2>
   <p className="text-ink-muted">{t("ownerFirstCheckHint")}</p>
   <div className="my-3 flex flex-col gap-2">
    {data.firstImportRows.map(row=><label key={row.date}
     className="flex min-h-12 items-center gap-3 border-b border-line py-2">
      <input type="checkbox" checked={selected.includes(row.date)} onChange={e=>setSelected(old=>
       e.target.checked?[...old,row.date]:old.filter(x=>x!==row.date))}/>
      <span className="flex-1"><bdi>{day(row.date)}</bdi></span>
      <span><bdi>{fmt(row.oursCents)}</bdi></span>
      <span><bdi>{fmt(row.toastCents)}</bdi></span>
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
  <ToastSummaryComparison restaurantNames={data.restaurantNames} businessId={businessId} days={data.comparisonDays} currency={currency} onSaved={load}/>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerNeedsLookCount",{count:data.needsLookCount})}</h2>
   {!data.needsLook.length&&<p className="text-ink-muted">{t("ownerNoIssues")}</p>}
   {data.needsLook.map((row,i)=><div key={row.restaurantGuid+row.date+i}
    className="border-b border-line py-4">
    <p className="font-semibold"><bdi>{day(row.date)}</bdi></p>
    {data.restaurantNames[row.restaurantGuid]&&<p>{data.restaurantNames[row.restaurantGuid]}</p>}
    <p className="text-ink-muted">{t("ownerOurs")}: <bdi>{fmt(row.oursCents)}</bdi> · {t("ownerToast")}: <bdi>{fmt(row.toastCents)}</bdi></p>
    <p>{t("ownerDifference")}: <bdi>{fmt(row.deltaCents)}</bdi></p>
    <p className="text-warn">{t("ownerReviewReason")}: {row.reason==="owner_flag"?t("ownerReasonOwner"):row.reason==="unparsed_orders"?t("unreadableOrders",{count:row.unreadableOrders}):row.reason==="owner_summary_mismatch"?t("summaryMismatch"):row.reason==="mismatch"?t("ownerReasonMismatch"):
     row.reason==="analytics_timeout"?t("ownerReasonTimeout"):row.reason==="coverage_invalid"?t("ownerReasonCoverage"):t("ownerReasonOther")}</p>
    <div className="mt-2 flex flex-wrap gap-2">
     <button disabled={!canRepullToastDay(data.importEnabled,busy,row.date,yesterday,data.queuedRanges)} className="min-h-12 rounded-full border border-line px-4"
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
    <span>{row.orders==null?t("noAmount"):t("ownerOrders",{count:number.format(row.orders)})}</span>
    <span className="text-ink-muted">{row.status==="checked_internal"?t("ownerState_checked_internal"):row.status==="owner_match"?t("ownerState_owner_match"):row.status==="checked"?t("ownerState_checked"):row.status==="checking"?t("ownerState_checking"):
     row.status==="missing"?t("ownerState_missing"):t("ownerState_needs_look")}</span>
    {row.paidOtherDay>0&&<p className="w-full text-muted">{t("paidOtherDayInfo",{count:row.paidOtherDay})}</p>}
    <details className="w-full"><summary className="min-h-12 cursor-pointer py-3">{t("summaryTitle")}</summary>
     <ToastSummaryComparison restaurantNames={data.restaurantNames} businessId={businessId} days={data.restaurantGuids.map(restaurantGuid=>({date:row.date,restaurantGuid,oursCents:null}))} currency={currency} onSaved={load}/>
    </details>
   </div>)}
  </section>
  <section className="rounded-card-lg bg-card p-5">
   <h2 className="text-xl font-bold">{t("ownerAnalytics")}</h2>
   <p className="text-ink-muted">{t("ownerAnalyticsNote")}</p>
   <p className="mt-2">{t("analyticsHelper")}</p>
   {data.analytics.errorCategory&&<p role="alert" className="mt-2 text-warn">{t(data.analytics.errorCategory==="missing_permissions"?"analyticsErrorPermissions":data.analytics.errorCategory==="authentication"?"analyticsErrorAuthentication":data.analytics.errorCategory==="invalid_host"?"analyticsErrorHost":"ownerError")}</p>}
   <button disabled={analyticsBusy} onClick={()=>void configureAnalytics("disconnect")} className="mt-3 min-h-12 rounded-full border border-line px-5">{t("analyticsSkip")}</button>
   <p className="mt-2 font-semibold">{data.analytics.verified?t("verified"):t("notConnected")}</p>
   <details className="mt-3">
    <summary className="min-h-12 cursor-pointer font-semibold">{t("ownerAnalyticsSetup")}</summary>
    <div className="mt-3 flex flex-col gap-3">
     {(["apiUrl","managementGroupGuid","clientId","clientSecret"] as const).map(key=>
      <label key={key} className="flex flex-col gap-1">
       <span>{t("ownerAnalytics_"+key)}</span>
       <input className="min-h-12 rounded-xl border border-line bg-card p-3"
        type={key==="clientSecret"?"password":"text"} autoComplete="off"
        value={analytics[key]} onChange={e=>setAnalytics(old=>({...old,[key]:e.target.value}))}/>
      </label>)}
     <button disabled={analyticsBusy||Object.values(analytics).some(x=>!x.trim())}
      onClick={()=>void configureAnalytics("connect")}
      className="min-h-12 rounded-full bg-accent px-5 text-on-accent disabled:opacity-40">
      {t("ownerAnalyticsConnect")}</button>
     {data.analytics.connected&&<button disabled={analyticsBusy}
      onClick={()=>void configureAnalytics("disconnect")}
      className="min-h-12 rounded-full border border-line px-5">
      {t("ownerAnalyticsDisconnect")}</button>}
    </div>
   </details>
  </section>
  {message&&<p role="status" className="rounded-xl bg-card p-3">{message}</p>}
 </div>;
}
