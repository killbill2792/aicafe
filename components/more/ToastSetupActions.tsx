"use client";
import {useEffect,useState} from "react";
type Labels={
 webhookSetup:string;createWebhook:string;webhookUrl:string;webhookSecret:string;
 saveWebhookSecret:string;webhookInactive:string;syncPreferences:string;syncKind:string;
 everyMinutes:string;enablePolling:string;disablePolling:string;pendingActivation:string;
 corrections:string;recovery:string;pending:string;error:string;success:string
};
type Subscription={id:string;enabled:boolean;webhookUrl?:string};
type Preferences={
 preferences:{kind:string;restaurant_guid:string;enabled:boolean;interval_minutes:number;last_failure_category:string|null}[];
 recovery:{restaurant_guid:string;state:string;kind:string}[];
 unresolvedCorrections:{restaurant_guid:string;business_date:string}[];
 schedulerActive?:boolean
};
export default function ToastSetupActions({businessId,restaurantGuids,enabled,labels}:{
 businessId:string;restaurantGuids:string[];enabled:boolean;labels:Labels
}){
 const [subscriptions,setSubscriptions]=useState<Subscription[]>([]);
 const [selection,setSelection]=useState("");
 const [verifiedRestaurants,setVerifiedRestaurants]=useState<string[]>(restaurantGuids);
 const [restaurant,setRestaurant]=useState("");
 const [secret,setSecret]=useState("");
 const [status,setStatus]=useState<Preferences|null>(null);
 const [kind,setKind]=useState("orders");
 const [minutes,setMinutes]=useState(60);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 async function reload(){
  const [a,b,c]=await Promise.all([
   fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"}),
   fetch("/api/pos/toast/webhook/subscriptions?businessId="+encodeURIComponent(businessId),
     {cache:"no-store"}),
   fetch("/api/pos/toast/sync-preferences?businessId="+encodeURIComponent(businessId),
     {cache:"no-store"}),
   fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"})
  ]);
  if(c.ok){
    const data=await c.json() as {locations:{restaurant_guid:string;verified_at:string|null}[]};
    setVerifiedRestaurants((data.locations??[]).filter(x=>Boolean(x.verified_at)).map(x=>x.restaurant_guid));
  }
  if(a.ok){
   const next=await a.json() as {subscriptions:Subscription[]};
   setSubscriptions(next.subscriptions??[]);
  }
  if(b.ok)setStatus(await b.json() as Preferences);
 }
 useEffect(()=>{
  let cancelled=false;
  Promise.all([
   fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"}),
   fetch("/api/pos/toast/webhook/subscriptions?businessId="+encodeURIComponent(businessId),{cache:"no-store"}),
   fetch("/api/pos/toast/sync-preferences?businessId="+encodeURIComponent(businessId),{cache:"no-store"})
  ]).then(async([connection,a,b])=>{
   if(connection.ok){
    const info=await connection.json() as {locations:{restaurant_guid:string;verified_at:string|null}[]};
    if(!cancelled)setVerifiedRestaurants((info.locations??[]).filter(l=>Boolean(l.verified_at)).map(l=>l.restaurant_guid));
   }
   if(cancelled)return;
   if(a.ok)setSubscriptions((await a.json() as {subscriptions:Subscription[]}).subscriptions??[]);
   if(b.ok)setStatus(await b.json() as Preferences);
  }).catch(()=>{});
  return ()=>{cancelled=true;};
 },[businessId]);
 async function post(url:string,payload:unknown){
  if(busy)return;
  setBusy(true);setMessage("");
  try{
   const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)});
   const result=await response.json() as {error?:string;subscriptionId?:string};
   if(!response.ok){setMessage(labels.error+": "+(result.error??"unavailable"));return;}
   if(result.subscriptionId)setSelection(result.subscriptionId);
   setSecret("");setMessage(labels.success);await reload();
  }catch{setMessage(labels.error);}
  finally{setBusy(false);}
 }
 const web= subscriptions.find(s=>s.id===selection)??subscriptions[0];
 const selected=restaurant||verifiedRestaurants[0]||"";
 const preference=status?.preferences.find(p=>p.restaurant_guid===selected&&p.kind===kind);
 return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
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
    {["orders","attendance","schedules","catalog","roster"].map(k=><option key={k} value={k}>{k}</option>)}
   </select></label>
  <label className="flex flex-col gap-1 text-sm">{labels.everyMinutes}
   <input type="number" min={15} max={1440} value={minutes}
    onChange={e=>setMinutes(Number(e.target.value))}
    className="min-h-11 rounded-xl border border-line p-2"/>
  </label>
  {enabled&&selected&&<button type="button" disabled={busy||minutes<15||minutes>1440}
   onClick={()=>void post("/api/pos/toast/sync-preferences",
    {businessId,restaurantGuid:selected,kind,intervalMinutes:minutes,
      enabled:!preference?.enabled})}
   className="min-h-11 rounded-full border border-line p-3 disabled:opacity-40">
   {preference?.enabled?labels.disablePolling:labels.enablePolling}
  </button>}
  {status&&<div className="text-sm text-ink-muted">
    <p>{labels.recovery}: {status.recovery.length}</p>
    <p>{labels.corrections}: {status.unresolvedCorrections.length}</p>
  </div>}
  {busy&&<p role="status">{labels.pending}</p>}
  {message&&<p role="status" className="text-sm text-ink">{message}</p>}
 </section>;
}
