"use client";
import {useCallback,useEffect,useState} from "react";
import en from "@/messages/en.json";

type Access={allowed:boolean;revision:number};
type FileAccess={id:string;threadId:string;name:string;mediaType:string;
 bytes:number;createdAt:string;allowed:boolean;revision:number};
type State={publicWeb:Access;fileRead:Access;files:FileAccess[];
 nextOffset:number|null;computer:{available:false;connected:false;reason:string}};
const copy=en.SupervisorAccess;
/** Read-only public web and explicitly selected files share this one owner
 * access state; Gmail's existing connection panel remains the sole mail UI. */
export default function SupervisorAccessPanel(){
 const [state,setState]=useState<State|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [loadingMore,setLoadingMore]=useState(false);
 const load=useCallback(async(offset=0)=>{
   const response=await fetch("/api/supervisor/access?offset="+offset,{
     cache:"no-store",credentials:"same-origin"});
   if(!response.ok)throw Error("access_read_failed");
   const latest=await response.json() as State;
   setState(previous=>offset>0&&previous?{
     ...latest,files:[...previous.files,...latest.files],
   }:latest);
 },[]);
 useEffect(()=>{let active=true;
   fetch("/api/supervisor/access?offset=0",{cache:"no-store",credentials:"same-origin"})
     .then(response=>{if(!response.ok)throw Error();return response.json() as Promise<State>;})
     .then(data=>{if(active)setState(data);})
     .catch(()=>{if(active)setError(copy.loadFailed);});
   return ()=>{active=false};
 },[]);
 const change=async(kind:"public_web"|"file_read"|"attachment",enabled:boolean,
    revision:number,attachmentId?:string)=>{
   if(busy)return;
   if(kind==="attachment"&&!window.confirm(copy.revokeConfirm))return;
   setBusy(true);setError("");
   try{
     const response=await fetch("/api/supervisor/access",{
       method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",
       body:JSON.stringify({kind,enabled,revision,...(attachmentId?{attachmentId}:{})}),
     });
     if(!response.ok)throw Error("access_write_failed");
     await load(0);
   }catch{setError(copy.saveFailed);}
   finally{setBusy(false);}
 };
 const more=async()=>{
   const offset=state?.nextOffset;
   if(loadingMore||offset===null||offset===undefined)return;
   setLoadingMore(true);setError("");
   try{await load(offset);}catch{setError(copy.loadFailed);}
   finally{setLoadingMore(false);}
 };
 return <div className="space-y-4">
  {!state&&!error&&<p role="status" className="text-[17px]">{copy.loading}</p>}
  {error&&<div className="space-y-2" role="alert">
    <p className="text-[15px] text-warn">{error}</p>
    <button type="button" onClick={()=>{setError("");void load().catch(()=>setError(copy.loadFailed));}}
     className="min-h-12 rounded-xl border border-line px-4 text-[17px]">{copy.refresh}</button>
  </div>}
  {state&&<>
   {([
    ["public_web",copy.publicWeb,copy.publicWebHelp,state.publicWeb],
    ["file_read",copy.fileRead,copy.fileReadHelp,state.fileRead],
   ] as const).map(([kind,label,help,permission])=>
    <section key={kind} className="rounded-card-lg border border-line bg-card p-5">
     <div className="flex items-start justify-between gap-3">
       <div className="min-w-0">
        <h2 className="font-headline text-xl font-bold">{label}</h2>
        <p className="mt-2 text-[17px] text-ink-muted">{help}</p>
       </div>
       <button type="button" role="switch" aria-label={label}
        aria-checked={permission.allowed} disabled={busy}
        onClick={()=>void change(kind,!permission.allowed,permission.revision)}
        className="min-h-12 min-w-20 shrink-0 rounded-xl border border-line px-3 text-[15px] font-semibold disabled:opacity-50">
        {busy?copy.changePending:permission.allowed?copy.on:copy.off}
       </button>
     </div>
    </section>
   )}
   <section className="rounded-card-lg border border-line bg-card p-5">
    <h2 className="font-headline text-xl font-bold">{copy.fileList}</h2>
    <p className="mt-2 text-[17px] text-ink-muted">{copy.fileListHelp}</p>
    {!state.files.length&&<p className="mt-4 text-[17px]">{copy.noFiles}</p>}
    <div className="mt-3 space-y-3">
      {state.files.map(file=><div key={file.id} role="group" aria-label={file.name}
        className="min-w-0 rounded-xl border border-line p-3">
       <p className="break-all text-[17px] font-semibold">{file.name}</p>
       <p className="mt-1 text-[15px] text-ink-muted">{!file.allowed?copy.fileRevoked:
         !state.fileRead.allowed?copy.filePaused:copy.fileAllowed}</p>
       {file.allowed&&<button type="button" disabled={busy} onClick={()=>
         void change("attachment",false,file.revision,file.id)}
         className="mt-2 min-h-12 rounded-xl border border-line px-3 text-[15px] font-semibold disabled:opacity-50">
         {copy.revokeFile}</button>}
      </div>)}
    </div>
    {state.nextOffset!==null&&<button type="button" disabled={loadingMore||busy}
      onClick={()=>void more()} className="mt-4 min-h-12 rounded-xl border border-line px-4 text-[17px]">
      {copy.loadMore}</button>}
   </section>
   <section className="rounded-card-lg border border-line bg-card p-5">
    <h2 className="font-headline text-xl font-bold">{copy.computer}</h2>
    <p className="mt-2 text-[17px] text-ink-muted">{copy.computerUnavailable}</p>
   </section>
  </>}
 </div>;
}