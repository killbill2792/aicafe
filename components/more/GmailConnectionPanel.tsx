"use client";
import {useEffect,useState} from "react";
import {Mail,ShieldCheck,CheckCircle2,AlertTriangle} from "lucide-react";
import en from "@/messages/en.json";

type Status={status:"active"|"needs_reconnect"|"revoking"|"disconnected";configured:boolean;
  email:string|null;permissions:{read:boolean;draft:boolean;send:boolean;organize:boolean}};
export default function GmailConnectionPanel(){
  const copy=en.GmailConnect;
  const [data,setData]=useState<Status|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const load=async()=>{
    const response=await fetch("/api/connectors/gmail/status",{cache:"no-store"});
    if(!response.ok)throw Error();
    setData(await response.json() as Status);
  };
  useEffect(()=>{let alive=true;
    void fetch("/api/connectors/gmail/status",{cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json() as Promise<Status>;})
      .then(x=>{if(alive)setData(x);})
      .catch(()=>{if(alive)setError(copy.statusUnavailable);});
    return ()=>{alive=false;};
  },[]);
  const disconnect=async()=>{
    if(busy||!window.confirm(copy.disconnectConfirm))return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/connectors/gmail/disconnect",{
        method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin"});
      await load();
      if(!response.ok)setError(copy.revokePending);
    }catch{setError(copy.revokePending);}
    finally{setBusy(false);}
  };
  const failure=typeof window!=="undefined"?new URLSearchParams(window.location.search).get("error"):null;
  const connected=data?.status==="active"&&Object.values(data.permissions).every(Boolean);
  return <section className="rounded-card-lg border border-line bg-card p-5 text-ink" aria-label={copy.title}>
    <div className="flex items-center gap-3">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft"><Mail aria-hidden="true" size={25}/></span>
      <div className="min-w-0 flex-1"><h2 className="font-headline text-xl font-bold">{copy.mailboxTitle}</h2>
        <p className="text-sm text-ink-muted">{copy.mailboxSubtitle}</p></div>
    </div>
    {!data&&!error?<p role="status" className="mt-5">{copy.loading}</p>:null}
    {connected?<div className="mt-5 flex items-start gap-3 rounded-xl bg-good-tint p-4 text-good">
      <CheckCircle2 aria-hidden="true" size={21}/>
      <div><p className="font-bold">{copy.connected}</p><p className="break-all text-sm">{data!.email}</p></div>
    </div>:data?<div className="mt-5 rounded-xl bg-surface2 p-4 text-ink">
      <p className="font-semibold">{data.status==="revoking"?copy.revoking:
        data.status==="needs_reconnect"?copy.reconnectRequired:copy.notConnected}</p>
      <p className="mt-1 text-sm text-ink-muted">{copy.googleConsent}</p></div>:null}
    <div className="mt-5 grid gap-3 text-sm text-ink-muted">
      <p className="flex gap-2"><ShieldCheck size={18} className="shrink-0"/>{copy.permissions}</p>
      <p>{copy.canDo}</p>
      <p>{copy.ownerApproves}</p>
    </div>
    {(error||failure)&&<p role="alert" className="mt-4 flex gap-2 text-warn">
      <AlertTriangle size={18} className="shrink-0"/>{error||copy.connectionFailed}</p>}
    <div className="mt-6 flex flex-wrap gap-3">
      {!connected&&data?.status!=="revoking"&&data?.configured&&<form
        action="/api/connectors/gmail/connect" method="get">
        <button type="submit"
          className="flex min-h-12 items-center justify-center rounded-xl bg-accent px-6 text-base font-bold text-white">
          {data?.status==="needs_reconnect"?copy.reconnect:copy.connect}
        </button>
      </form>}
      {connected&&<button type="button" onClick={()=>void disconnect()} disabled={busy}
        className="min-h-12 rounded-xl border border-line px-5 text-base font-bold disabled:opacity-50">
        {busy?copy.disconnecting:copy.disconnect}
      </button>}
      {data?.status==="revoking"&&<button type="button" onClick={()=>void disconnect()} disabled={busy}
        className="min-h-12 rounded-xl border border-line px-5 font-bold">{copy.retryRevoke}</button>}
    </div>
    {data&&!data.configured&&<p className="mt-4 text-sm text-warn">{copy.notConfigured}</p>}
    <p className="mt-4 text-xs text-ink-muted">{copy.disconnectHint}</p>
  </section>;
}
