"use client";
import {useEffect,useState} from "react";
type Copy={title:string;description:string;enable:string;disable:string;
  blocked:string;unsupported:string;enabled:string;error:string;loading:string};
type State={available:boolean;subscribed:boolean;publicKey:string|null};
const fromBase64Url=(input:string)=>{
  const base64=input.replace(/-/g,"+").replace(/_/g,"/");
  const bytes=atob(base64.padEnd(Math.ceil(base64.length/4)*4,"="));
  return Uint8Array.from(bytes,ch=>ch.charCodeAt(0));
};
/** User gesture is the ONLY browser permission request. No automatic prompt. */
export default function OwnerPushReports({copy}:{copy:Copy}){
  const [state,setState]=useState<State|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const supported=typeof window!=="undefined"&&"serviceWorker" in navigator&&
    "PushManager" in window&&"Notification" in window;
  useEffect(()=>{
    let live=true;
    void (async()=>{
      const response=await fetch("/api/ai/push-subscriptions",{cache:"no-store"});
      if(!response.ok)throw Error("push_load_failed");
      const result=await response.json() as State;
      if(!result.available||!supported){if(live)setState(result);return;}
      const registration=await navigator.serviceWorker.getRegistration();
      const existing=await registration?.pushManager?.getSubscription();
      if(existing?.endpoint){
        const checked=await fetch("/api/ai/push-subscriptions",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({checkEndpoint:existing.endpoint}),
        });
        if(!checked.ok)throw Error("push_state_unavailable");
        const current=await checked.json() as {subscribed:boolean};
        if(live)setState({...result,subscribed:current.subscribed===true});
      }else if(live)setState({...result,subscribed:false});
    })().catch(()=>{if(live)setError(copy.error)});
    return ()=>{live=false};
  },[copy.error,supported]);
  async function enable(){
    if(busy||!supported||!state?.available||!state.publicKey)return;
    setBusy(true);setError("");
    try{
      const permission=await Notification.requestPermission();
      if(permission!=="granted"){setError(copy.blocked);return;}
      const reg=await navigator.serviceWorker.ready;
      let sub=await reg.pushManager.getSubscription();
      if(!sub)sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,applicationServerKey:fromBase64Url(state.publicKey),
      });
      const body=sub.toJSON();
      if(!body.endpoint||!body.keys?.p256dh||!body.keys?.auth)
        throw Error("push_serialization_invalid");
      const response=await fetch("/api/ai/push-subscriptions",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({consent:true,subscription:{
          endpoint:body.endpoint,keys:{
            p256dh:body.keys.p256dh,auth:body.keys.auth,
          },
        }}),
      });
      if(!response.ok)throw Error("push_consent_failed");
      setState({...state,subscribed:true});
    }catch{setError(copy.error);}
    finally{setBusy(false);}
  }
  async function disable(){
    if(busy)return;setBusy(true);setError("");
    try{
      // Remove server consent first. A browser unsubscription failure must
      // never leave the user opted in to a different device.
      const reg=supported?await navigator.serviceWorker.getRegistration():null;
      const sub=await reg?.pushManager?.getSubscription();
      if(!sub?.endpoint)throw Error("push_device_not_found");
      const response=await fetch("/api/ai/push-subscriptions",{
        method:"DELETE",headers:{"content-type":"application/json"},
        body:JSON.stringify({endpoint:sub.endpoint}),
      });
      if(!response.ok)throw Error("push_revoke_failed");
      setState(current=>current?{...current,subscribed:false}:current);
      await sub.unsubscribe();
    }catch{setError(copy.error);}
    finally{setBusy(false);}
  }
  return <section className="rounded-2xl border border-line bg-card p-4">
    <h2 className="font-headline text-xl font-bold text-ink">{copy.title}</h2>
    <p className="mt-2 text-[17px] text-ink-muted">{copy.description}</p>
    {!state?<p className="mt-2 text-ink-muted">{copy.loading}</p>:
      !state.available||!supported?<p className="mt-2 text-ink-muted">{copy.unsupported}</p>:
      <button type="button" onClick={()=>void(state.subscribed?disable():enable())}
        disabled={busy} className="mt-3 min-h-12 rounded-full border border-line px-5 font-bold text-ink disabled:opacity-50">
        {busy?copy.loading:state.subscribed?copy.disable:copy.enable}
      </button>}
    {state?.subscribed?<p className="mt-2 text-sm text-ink-muted">{copy.enabled}</p>:null}
    {error?<p className="mt-2 text-sm text-ink" role="alert">{error}</p>:null}
  </section>;
}
