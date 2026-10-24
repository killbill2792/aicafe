"use client";
import {useEffect,useState} from "react";
import {useLocale} from "next-intl";
import {saveThenVerifyToastConnection,toastStatus,latestToastSync} from "./toastConnectFlow";
type Location={id:string;name:string};
type State={
 state:string;apiOrigin:string|null;lastVerifiedAt:string|null;
 lastErrorCategory:string|null;retryAfter?:string|null;
 locations:{location_id:string;restaurant_guid:string;verified_at:string|null}[];
 syncLocations?:{restaurant_guid:string;last_order_fetch_at:string|null;last_time_entry_fetch_at:string|null;
  last_schedule_fetch_at:string|null;last_menu_fetch_at:string|null;last_failure_category:string|null}[];
};
type Labels={
 notEnabled:string;notConnected:string;configured:string;verified:string;
 missingPermissions:string;needsReconnect:string;lastSyncFailed:string;stale:string;
 url:string;clientId:string;clientSecret:string;locations:string;
 restaurantGuid:string;save:string;test:string;disconnect:string;
 lastVerified:string;error:string;saved:string;success:string;pending:string;
 disconnectConfirm:string;noLocations:string;instructions:string;retryAfter:string;lastSync:string;
 errorAuthentication:string;errorMissingPermissions:string;errorUnauthorizedLocation:string;
 errorTimeout:string;errorRateLimited:string;errorUnavailable:string;errorInvalidResponse:string;
 needsAttention:string;fix:string;technicalDetails:string;connectedLastSync:string;
 noSyncYet:string;manualLocationHint:string;
};
export default function ToastConnectionForm({businessId,locations,enabled,approvedOrigins,defaultApiOrigin,labels}:{
 businessId:string;locations:Location[];enabled:boolean;
 approvedOrigins:string[];defaultApiOrigin:string;labels:Labels;
}) {
 const locale=useLocale();
 const [apiUrl,setApiUrl]=useState(defaultApiOrigin);
 const [clientId,setClientId]=useState("");
 const [secret,setSecret]=useState("");
 const [mapping,setMapping]=useState<Record<string,string>>({});
 const [connection,setConnection]=useState<State|null>(null);
 const [pending,setPending]=useState(false);
 const [message,setMessage]=useState("");
 async function load(){
  const result=await fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
  if(!result.ok)throw new Error("unavailable");
  const data=await result.json() as State;
  setConnection(data);
  setApiUrl(data.apiOrigin&&approvedOrigins.includes(data.apiOrigin)?data.apiOrigin:defaultApiOrigin);
  setMapping(Object.fromEntries((data.locations??[]).map(m=>[m.location_id,m.restaurant_guid])));
 }
 useEffect(()=>{
  let cancelled=false;
  fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"})
   .then(r=>r.ok?r.json():null).then((data:State|null)=>{
    if(cancelled||!data)return;
    setConnection(data);
    setApiUrl(data.apiOrigin&&approvedOrigins.includes(data.apiOrigin)?data.apiOrigin:defaultApiOrigin);
    setMapping(Object.fromEntries((data.locations??[]).map(m=>[m.location_id,m.restaurant_guid])));
   }).catch(()=>{if(!cancelled)setMessage(labels.errorUnavailable);});
  return ()=>{cancelled=true;};
 },[businessId,approvedOrigins,defaultApiOrigin,labels.errorUnavailable]);
 const errors:Record<string,string>={
  authentication:labels.errorAuthentication,missing_permissions:labels.errorMissingPermissions,
  unauthorized_location:labels.errorUnauthorizedLocation,timeout:labels.errorTimeout,
  rate_limited:labels.errorRateLimited,unavailable:labels.errorUnavailable,
  invalid_response:labels.errorInvalidResponse
 };
 const status=toastStatus(connection?.state);
 const lastSync=latestToastSync(connection?.syncLocations);
 function time(value:string){
  return new Date(value).toLocaleString(locale);
 }
 async function perform(action:"save"|"test"|"disconnect"){
  if(pending)return;
  if(action==="disconnect"&&!window.confirm(labels.disconnectConfirm))return;
  setPending(true);setMessage("");
  try{
   if(action==="save"){
    const rows=locations.map(location=>({location_id:location.id,
     restaurant_guid:(mapping[location.id]??"").trim()})).filter(row=>row.restaurant_guid);
    const outcome=await saveThenVerifyToastConnection({
     businessId,apiUrl,clientId,clientSecret:secret,locations:rows
    });
    if(outcome.saved)setSecret("");
    await load();
    const reason=errors[outcome.error??""]??labels.errorUnavailable;
    setMessage(outcome.verified?labels.verified:
     outcome.saved?labels.saved+" "+labels.error+": "+reason:labels.error+": "+reason);
    return;
   }
   const response=await fetch(action==="test"?"/api/pos/toast/test":
    "/api/pos/toast?businessId="+encodeURIComponent(businessId),{
    method:action==="disconnect"?"DELETE":"POST",
    headers:{"Content-Type":"application/json"},
    body:action==="test"?JSON.stringify({businessId}):undefined
   });
   const result=await response.json() as {error?:string;state?:string};
   if(!response.ok){
    setMessage(labels.error+": "+(errors[result.error??""]??labels.errorUnavailable));
    await load();return;
   }
   await load();
   setMessage(action==="test"&&result.state==="verified"?labels.verified:labels.success);
  }catch{setMessage(labels.errorUnavailable);}
  finally{setPending(false);}
 }
 return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
  <p className="text-base text-ink-muted">{labels.instructions}</p>
  <div className="flex flex-wrap items-center justify-between gap-3">
   <p role="status" className="text-base font-semibold text-ink">
    {status==="notConnected"?labels.notConnected:
     status==="connected"?labels.connectedLastSync.replace("{time}",lastSync?time(lastSync):labels.noSyncYet):
      labels.needsAttention}
   </p>
   {status==="needsAttention"&&<a href="#toast-keys"
    className="inline-flex min-h-12 items-center rounded-full bg-warn-tint px-5 font-semibold text-warn">{labels.fix}</a>}
  </div>
  {connection?.lastErrorCategory&&<p role="alert" className="text-sm text-warn">
   {errors[connection.lastErrorCategory]??labels.errorUnavailable}</p>}
  {!enabled&&<p role="status" className="text-base text-ink-muted">{labels.notEnabled}</p>}
  {enabled&&<>
   <div id="toast-keys" className="flex flex-col gap-3 scroll-mt-6">
    <label className="flex flex-col gap-1 text-base font-semibold text-ink">
     {labels.clientId}
     <input className="min-h-12 rounded-xl border border-line bg-surface px-3" value={clientId}
      onChange={e=>setClientId(e.target.value)} autoComplete="off" />
    </label>
    <label className="flex flex-col gap-1 text-base font-semibold text-ink">
     {labels.clientSecret}
     <input type="password" className="min-h-12 rounded-xl border border-line bg-surface px-3"
      value={secret} onChange={e=>setSecret(e.target.value)} autoComplete="new-password"/>
    </label>
   </div>
   <div className="flex flex-wrap gap-3">
    <button disabled={pending||!secret||!approvedOrigins.includes(apiUrl)||!clientId||
      !Object.values(mapping).some(Boolean)}
     onClick={()=>void perform("save")} type="button"
     className="min-h-12 rounded-full bg-accent px-5 py-3 font-semibold text-on-accent disabled:opacity-40">
     {pending?labels.pending:labels.save}
    </button>
    <button disabled={pending||!connection||connection.state==="not_connected"}
     onClick={()=>void perform("test")} type="button"
     className="min-h-12 rounded-full border border-line px-5 py-3 font-semibold text-ink disabled:opacity-40">
     {labels.test}
    </button>
   </div>
   {!Object.values(mapping).some(Boolean)&&<p className="text-sm text-ink-muted">{labels.manualLocationHint}</p>}
   <details className="rounded-xl border border-line p-3">
    <summary className="cursor-pointer text-base font-semibold text-ink">{labels.technicalDetails}</summary>
    <div className="mt-4 flex flex-col gap-4">
     {approvedOrigins.length>1&&<label className="flex flex-col gap-1 text-base font-semibold text-ink">
      {labels.url}
      <select className="min-h-12 rounded-xl border border-line bg-surface px-3" value={apiUrl}
       onChange={e=>setApiUrl(e.target.value)}>
       <option value="">{labels.url}</option>
       {approvedOrigins.map(origin=><option key={origin} value={origin}>{origin}</option>)}
      </select>
     </label>}
     <h2 className="text-lg font-semibold text-ink">{labels.locations}</h2>
     {locations.length?locations.map(location=><label key={location.id}
      className="flex flex-col gap-1 text-base font-semibold text-ink">
      {location.name} — {labels.restaurantGuid}
      <input className="min-h-12 rounded-xl border border-line bg-surface px-3"
       value={mapping[location.id]??""}
       onChange={e=>setMapping(old=>({...old,[location.id]:e.target.value}))}
       autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
     </label>):<p>{labels.noLocations}</p>}
     {connection?.lastVerifiedAt&&<p className="text-sm text-ink-muted">
      {labels.lastVerified}: {time(connection.lastVerifiedAt)}</p>}
     {connection?.retryAfter&&<p className="text-sm text-ink-muted">
      {labels.retryAfter}: {time(connection.retryAfter)}</p>}
     <button disabled={pending||status==="notConnected"} onClick={()=>void perform("disconnect")}
      type="button" className="min-h-12 rounded-full border border-line px-5 py-3 font-semibold text-warn disabled:opacity-40">
      {labels.disconnect}
     </button>
    </div>
   </details>
  </>}
  {message&&<p role="status" className="rounded-xl bg-paper p-3 text-sm text-ink">{message}</p>}
 </section>;
}
