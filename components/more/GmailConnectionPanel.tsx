"use client";
import {useEffect,useState} from "react";
import {Mail,ShieldCheck,CheckCircle2,AlertTriangle} from "lucide-react";
import en from "@/messages/en.json";

type Status={status:"active"|"needs_reconnect"|"revoking"|"disconnected";configured:boolean;
  email:string|null;accountId:string|null;generation:number|null;
  enabledOperations:string[];googleScopeGranted:boolean;
  permissions:{read:boolean;draft:boolean;send:boolean;organize:boolean}};
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
  const toggle=async(operation:"read"|"draft"|"send"|"organize")=>{
    if(busy||data?.status!=="active"||!data.accountId||!data.generation)return;
    const enabled=data.enabledOperations.includes(operation);
    if(!enabled&&["send","organize"].includes(operation)&&!window.confirm(copy.enableOperationConfirm))return;
    setBusy(true);setError("");
    try{
      const operations=enabled?data.enabledOperations.filter(x=>x!==operation):
        [...data.enabledOperations,operation];
      const response=await fetch("/api/connectors/gmail/permissions",{
        method:"PATCH",credentials:"same-origin",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({accountId:data.accountId,generation:data.generation,operations}),
      });
      if(!response.ok)throw new Error("permission_change_unverified");
      await load();
    }catch{setError(copy.operationFailed);}
    finally{setBusy(false);}
  };
  const failure=typeof window!=="undefined"?new URLSearchParams(window.location.search).get("error"):null;
  const connected=data?.status==="active";
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
    {connected&&data?.accountId&&<div className="mt-5 space-y-3">
      <h3 className="text-[17px] font-semibold">{copy.operationHeading}</h3>
      <p className="text-[15px] text-ink-muted">{copy.googleScopeNotice}</p>
      {( [
        ["read",copy.opRead],["draft",copy.opDraft],
        ["send",copy.opSend],["organize",copy.opOrganize],
      ] as const).map(([operation,label])=><div key={operation}
        className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-2">
        <span className="min-w-0 text-[15px]">{label}</span>
        <button type="button" role="switch" aria-checked={data.enabledOperations.includes(operation)}
          aria-label={label} disabled={busy} onClick={()=>void toggle(operation)}
          className="min-h-12 min-w-20 shrink-0 rounded-xl border border-line px-3 text-[15px] font-semibold disabled:opacity-50">
          {busy?copy.operationSaving:data.enabledOperations.includes(operation)?copy.operationOn:copy.operationOff}
        </button>
      </div>)}
    </div>}
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
