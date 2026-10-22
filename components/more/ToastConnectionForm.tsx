"use client";
import {useEffect,useState} from "react";
import {saveThenVerifyToastConnection} from "./toastConnectFlow";
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
};
export default function ToastConnectionForm({businessId,locations,enabled,approvedOrigins,defaultApiOrigin,labels}:{
 businessId:string;locations:Location[];enabled:boolean;
 approvedOrigins:string[];defaultApiOrigin:string;labels:Labels;
}) {
 const [apiUrl,setApiUrl]=useState(defaultApiOrigin);
 const [clientId,setClientId]=useState("");
 const [secret,setSecret]=useState("");
 const [mapping,setMapping]=useState<Record<string,string>>({});
 const [connection,setConnection]=useState<State|null>(null);
 const [pending,setPending]=useState(false);
 const [message,setMessage]=useState("");
 async function load() {
   const result=await fetch("/api/pos/toast?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
   if(!result.ok)return;
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
    }).catch(()=>{});
   return ()=>{cancelled=true;};
 },[businessId,approvedOrigins,defaultApiOrigin]);
 const errorText:Record<string,string>={
  authentication:labels.errorAuthentication,missing_permissions:labels.errorMissingPermissions,
  unauthorized_location:labels.errorUnauthorizedLocation,timeout:labels.errorTimeout,
  rate_limited:labels.errorRateLimited,unavailable:labels.errorUnavailable,
  invalid_response:labels.errorInvalidResponse
 };
 const stateText:Record<string,string>={
   not_connected:labels.notConnected,configured:labels.configured,
   verified:labels.verified,missing_permissions:labels.missingPermissions,
   needs_reconnect:labels.needsReconnect,sync_failed:labels.lastSyncFailed,stale:labels.stale
 };
 async function perform(action:"save"|"test"|"disconnect") {
   if(pending)return;
   if(action==="disconnect"&&!window.confirm(labels.disconnectConfirm))return;
   setPending(true);setMessage("");
   try {
     if(action==="save"){
       const rows=locations.map(location=>({location_id:location.id,
         restaurant_guid:(mapping[location.id]??"").trim()})).filter(row=>row.restaurant_guid);
       const outcome=await saveThenVerifyToastConnection({
         businessId,apiUrl,clientId,clientSecret:secret,locations:rows
       });
       if(outcome.saved)setSecret("");
       await load();
       const reason=errorText[outcome.error??""]??outcome.error??labels.errorUnavailable;
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
       setMessage(labels.error+": "+(errorText[result.error??""]??result.error??labels.errorUnavailable));
       await load();return;
     }
     await load();
     setMessage(action==="test"&&result.state==="verified"?labels.verified:labels.success);
   }catch {setMessage(labels.error);}
   finally {setPending(false);}
 }
 const entries=locations.map(location=>(
   <label key={location.id} className="flex flex-col gap-1.5 text-base font-semibold text-ink">
     <span>{location.name} — {labels.restaurantGuid}</span>
     <input className="min-h-12 rounded-xl border border-line bg-surface px-3 text-base"
       value={mapping[location.id]??""}
       onChange={e=>setMapping(current=>({...current,[location.id]:e.target.value}))}
       autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
   </label>
 ));
 return <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
   <p className="text-base text-ink-muted">{labels.instructions}</p>
   <p className="text-base font-semibold text-ink">
      {stateText[connection?.state??"not_connected"]??labels.notConnected}
   </p>
   {connection?.lastVerifiedAt&&<p className="text-sm text-ink-muted">
     {labels.lastVerified}: {new Date(connection.lastVerifiedAt).toLocaleString()}
   </p>}
   {connection?.retryAfter&&<p className="text-sm text-ink-muted">
     {labels.retryAfter}: {new Date(connection.retryAfter).toLocaleString()}
   </p>}
   {connection?.lastErrorCategory&&<p role="status" className="text-sm text-warn">
     {labels.error}: {errorText[connection.lastErrorCategory]??labels.error}
   </p>}
   {connection?.syncLocations?.map(h=>{
     const synced=[h.last_order_fetch_at,h.last_time_entry_fetch_at,h.last_schedule_fetch_at,h.last_menu_fetch_at]
       .filter((value):value is string=>Boolean(value)).sort().at(-1);
     return <p key={h.restaurant_guid} className="text-sm text-ink-muted">
       {labels.lastSync} ({h.restaurant_guid.slice(0,8)}): {synced?new Date(synced).toLocaleString():labels.notConnected}
     </p>;
   })}
   {!enabled&&<p role="status" className="rounded-xl bg-paper p-3 text-ink">
     {labels.notEnabled}
   </p>}
   {enabled&&<>
     {approvedOrigins.length>1&&<label className="flex flex-col gap-1 text-base font-semibold text-ink">
       <span>{labels.url}</span>
       <select className="min-h-12 rounded-xl border border-line bg-surface px-3"
         value={apiUrl} onChange={e=>setApiUrl(e.target.value)}>
         <option value="">{labels.url}</option>
         {approvedOrigins.map(origin=><option key={origin} value={origin}>{origin}</option>)}
       </select>
     </label>}
     <label className="flex flex-col gap-1 text-base font-semibold text-ink">
       <span>{labels.clientId}</span>
       <input className="min-h-12 rounded-xl border border-line bg-surface px-3"
         value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off"/>
     </label>
     <label className="flex flex-col gap-1 text-base font-semibold text-ink">
       <span>{labels.clientSecret}</span>
       <input type="password" className="min-h-12 rounded-xl border border-line bg-surface px-3"
         value={secret} onChange={e=>setSecret(e.target.value)} autoComplete="new-password"/>
     </label>
     <h2 className="text-lg font-bold text-ink">{labels.locations}</h2>
     {entries.length?entries:<p>{labels.noLocations}</p>}
     <button disabled={pending||!secret||!approvedOrigins.includes(apiUrl)||!clientId||!Object.values(mapping).some(Boolean)}
       onClick={()=>void perform("save")} type="button"
       className="min-h-12 rounded-full bg-accent p-3 font-semibold text-on-accent disabled:opacity-40">
       {pending?labels.pending:labels.save}
     </button>
     <button disabled={pending||!connection||connection.state==="not_connected"}
       onClick={()=>void perform("test")} type="button"
       className="min-h-12 rounded-full border border-line p-3 font-semibold text-ink disabled:opacity-40">
       {labels.test}
     </button>
     <button disabled={pending||!connection||connection.state==="not_connected"}
       onClick={()=>void perform("disconnect")} type="button"
       className="min-h-12 rounded-full border border-line p-3 font-semibold text-warn disabled:opacity-40">
       {labels.disconnect}
     </button>
   </>}
   {message&&<p role="status" className="rounded-xl bg-paper p-3 text-sm text-ink">{message}</p>}
 </section>;
}
