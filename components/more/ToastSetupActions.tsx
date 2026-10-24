"use client";
import {useEffect,useRef,useState} from "react";
import {useLocale} from "next-intl";
import {loadToastOwnerSetupState,type ToastOwnerSetupStatus,type ToastWebhookSubscription}
 from "./toastSetupState";
import ToastOperationalReview, {type ToastReviewLabels} from "./ToastOperationalReview";
type Labels={
 webhookSetup:string;createWebhook:string;webhookUrl:string;webhookSecret:string;
 saveWebhookSecret:string;webhookInactive:string;syncPreferences:string;syncKind:string;
 everyMinutes:string;kindLabels:Record<"orders"|"attendance"|"schedules"|"catalog"|"roster",string>;technicalDetails:string;daysMissing:string;syncAgain:string;noMissingDays:string;syncUnavailable:string;statusUnavailable:string;dayStaged:string;enablePolling:string;disablePolling:string;pendingActivation:string;
 corrections:string;recovery:string;pending:string;error:string;success:string
};
export default function ToastSetupActions({businessId,restaurantGuids,enabled,pilotEnabled,labels,reviewLabels}:{
 businessId:string;restaurantGuids:string[];enabled:boolean;pilotEnabled:boolean;
 labels:Labels;reviewLabels:ToastReviewLabels
}){
 const [subscriptions,setSubscriptions]=useState<ToastWebhookSubscription[]>([]);
 const [selection,setSelection]=useState("");
 const [verifiedRestaurants,setVerifiedRestaurants]=useState<string[]>(restaurantGuids);
 const [restaurant,setRestaurant]=useState("");
 const [secret,setSecret]=useState("");
 const [status,setStatus]=useState<ToastOwnerSetupStatus|null>(null);
 const [statusError,setStatusError]=useState(false);
 const [locationMappings,setLocationMappings]=useState<{restaurant_guid:string;location_id:string}[]>([]);
 const [kind,setKind]=useState("orders");

 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [dayPending,setDayPending]=useState<string|null>(null);
 const requestVersion=useRef(0);
 async function reload(){
  const version=++requestVersion.current;
  try{
   const snapshot=await loadToastOwnerSetupState(businessId);
   if(version!==requestVersion.current)return false;
   setVerifiedRestaurants(snapshot.restaurantGuids);
   setSubscriptions(snapshot.subscriptions);
   setLocationMappings(snapshot.locationMappings);
   setStatus(snapshot.status);setStatusError(false);
   return true;
  }catch{
   if(version!==requestVersion.current)return false;
   // No old verification/disabled flag may survive a failed status refresh.
   setVerifiedRestaurants([]);setSubscriptions([]);setStatus(null);setLocationMappings([]);setStatusError(true);
   return false;
  }
 }
 useEffect(()=>{
  let cancelled=false;
  const version=++requestVersion.current;
  const onConnectionChange=()=>{void reload();};
  window.addEventListener("toast-connection-changed",onConnectionChange);
  loadToastOwnerSetupState(businessId).then(snapshot=>{
    if(cancelled||version!==requestVersion.current)return;
    setVerifiedRestaurants(snapshot.restaurantGuids);
    setSubscriptions(snapshot.subscriptions);
    setLocationMappings(snapshot.locationMappings);
    setStatus(snapshot.status);setStatusError(false);
  }).catch(()=>{
    if(cancelled||version!==requestVersion.current)return;
    setVerifiedRestaurants([]);setSubscriptions([]);setStatus(null);setLocationMappings([]);setStatusError(true);
  });
  return ()=>{cancelled=true;window.removeEventListener("toast-connection-changed",onConnectionChange);};
 },[businessId]);
 async function post(url:string,payload:unknown){
  if(busy)return;
  setBusy(true);setMessage("");
  try{
   const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)});
   const result=await response.json() as {error?:string;subscriptionId?:string};
   if(!response.ok){setMessage(labels.error);return;}
   if(result.subscriptionId)setSelection(result.subscriptionId);
   setSecret("");const loaded=await reload();
   setMessage(loaded?labels.success:labels.error);
  }catch{setMessage(labels.error);}
  finally{setBusy(false);}
 }
 async function syncDay(restaurantGuid:string,date:string){
  if(busy||dayPending)return;
  setDayPending(restaurantGuid+":"+date);setMessage("");
  try{
   const response=await fetch("/api/pos/toast/pilot",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({businessId,restaurantGuid,
     locationId:locationMappings.find(l=>l.restaurant_guid===restaurantGuid)?.location_id,businessDate:date})});
   if(!response.ok)throw new Error("unavailable");
   const loaded=await reload();setMessage(loaded?labels.dayStaged:labels.syncUnavailable);
  }catch{setMessage(labels.syncUnavailable);}
  finally{setDayPending(null);}
 }
 const web= subscriptions.find(s=>s.id===selection)??subscriptions[0];
 const selected=verifiedRestaurants.includes(restaurant)?restaurant:verifiedRestaurants[0]??"";
 const preference=status?.preferences.find(p=>p.restaurant_guid===selected&&p.kind===kind);
 const missingDays=[...new Map((status?.unresolvedCorrections??[])
  .filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d.business_date)).map(d=>[d.restaurant_guid+":"+d.business_date,d])).values()]
  .sort((a,b)=>b.business_date.localeCompare(a.business_date));
 const gaps=(status?.recovery??[]).filter(g=>g.missing_since||g.missing_until);
 const locale=useLocale();
 function localDay(day:string){
  return new Date(day+"T12:00:00Z").toLocaleDateString(locale,{timeZone:"UTC",year:"numeric",month:"short",day:"numeric"});
 }
 return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
  <details className="rounded-xl border border-line p-3">
  <summary className="cursor-pointer text-base font-semibold">{labels.technicalDetails}</summary>
  <div className="mt-4 flex flex-col gap-3">
  <h2 className="text-lg font-bold text-ink">{labels.webhookSetup}</h2>
  <p className="text-sm text-ink-muted">{labels.webhookInactive}</p>
  {web?.webhookUrl&&<label className="flex flex-col gap-1 text-sm text-ink">
   {labels.webhookUrl}
   <input readOnly value={web.webhookUrl} className="rounded-xl border border-line p-3"/>
  </label>}
  {enabled&&<button type="button" disabled={busy||!verifiedRestaurants.length}
   onClick={()=>void post("/api/pos/toast/webhook/subscriptions",
     {action:"prepare",businessId})}
   className="min-h-11 rounded-full border border-line p-3 disabled:opacity-40">
   {labels.createWebhook}</button>}
  {enabled&&web&&<label className="flex flex-col gap-1 text-sm text-ink">
   {labels.webhookSecret}
   <input type="password" autoComplete="new-password" value={secret}
    onChange={e=>setSecret(e.target.value)}
    className="min-h-11 rounded-xl border border-line p-3"/>
  </label>}
  {enabled&&web&&<button type="button" disabled={busy||secret.length<32}
   onClick={()=>void post("/api/pos/toast/webhook/subscriptions",
    {action:"register_secret",businessId,subscriptionId:web.id,signingSecret:secret})}
   className="min-h-11 rounded-full border border-line p-3 disabled:opacity-40">
   {labels.saveWebhookSecret}</button>}
  <h2 className="text-lg font-bold text-ink">{labels.syncPreferences}</h2>
  <p className="text-sm text-ink-muted">{labels.pendingActivation}</p>
  {verifiedRestaurants.length>1&&<select value={selected}
   onChange={e=>setRestaurant(e.target.value)}
   className="min-h-11 rounded-xl border border-line p-2">
   {verifiedRestaurants.map(r=><option key={r} value={r}>{r.slice(0,8)}</option>)}
  </select>}
  <label className="flex flex-col gap-1 text-sm">{labels.syncKind}
   <select value={kind} onChange={e=>setKind(e.target.value)}
    className="min-h-11 rounded-xl border border-line p-2">
    {(["orders","attendance","schedules","catalog","roster"] as const).map(k=><option key={k} value={k}>{labels.kindLabels[k]}</option>)}
   </select></label>
  {enabled&&selected&&<button type="button" disabled={busy}
   onClick={()=>void post("/api/pos/toast/sync-preferences",
    {businessId,restaurantGuid:selected,kind,intervalMinutes:preference?.interval_minutes??60,
      enabled:!preference?.enabled})}
   className="min-h-11 rounded-full border border-line p-3 disabled:opacity-40">
   {preference?.enabled?labels.disablePolling:labels.enablePolling}
  </button>}
  </div></details>
  <div className="flex flex-col gap-3">
   <h2 className="text-lg font-bold text-ink">{labels.daysMissing}</h2>
   {status&&missingDays.map(day=><div key={day.restaurant_guid+day.business_date}
    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
    <span className="text-base text-ink">{localDay(day.business_date)}</span>
    <button type="button" disabled={Boolean(dayPending)||!pilotEnabled||
     !locationMappings.some(l=>l.restaurant_guid===day.restaurant_guid)}
     onClick={()=>void syncDay(day.restaurant_guid,day.business_date)}
     className="min-h-12 rounded-full border border-line px-4 font-semibold disabled:opacity-40">
     {labels.syncAgain}</button>
   </div>)}
   {status&&gaps.map((g,i)=><div key={g.restaurant_guid+":"+g.kind+":"+i}
    className="rounded-xl border border-line p-3 text-base text-ink">
    <p>{labels.recovery}: {g.missing_since?localDay(g.missing_since.slice(0,10)):"?"} – {g.missing_until?localDay(g.missing_until.slice(0,10)):"?"}</p>
    <p className="text-sm text-ink-muted">{labels.syncUnavailable}</p>
   </div>)}
   {status&&!missingDays.length&&!gaps.length&&<p className="text-base text-ink-muted">{labels.noMissingDays}</p>}
  </div>
  {!status&&<p role="status" className="text-base text-ink-muted">{statusError?labels.statusUnavailable:labels.pending}</p>}
  {selected&&<ToastOperationalReview key={businessId+":"+selected}
    businessId={businessId} restaurantGuid={selected}
    enabled={pilotEnabled} labels={reviewLabels}/>}
  {busy&&<p role="status">{labels.pending}</p>}
  {message&&<p role="status" className="text-sm text-ink">{message}</p>}
 </section>;
}
