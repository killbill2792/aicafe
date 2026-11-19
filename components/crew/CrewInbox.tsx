"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";
import type {StaffMessage,StaffRequest} from "@/lib/staffCommunication/channel.server";
import {crewOutboxKey,crewRejectedDraftKey,loadCrewPending,saveCrewPending,sameCrewOperation,
 deliverCrewWithRetry,type PendingCrewSubmission} from "@/lib/staffCommunication/pendingSend";
export default function CrewInbox({name,requests,messages,authUserId}:{
 name:string;requests:StaffRequest[];messages:StaffMessage[];authUserId:string;
}){
 const router=useRouter(),sending=useRef(false);
 const pendingRef=useRef<PendingCrewSubmission|null>(null);
 const storageKey=crewOutboxKey(authUserId),draftKey=crewRejectedDraftKey(authUserId);
 const [rejectedDraft,setRejectedDraft]=useState("");
 const [pending,setPending]=useState(false);
 const [notes,setNotes]=useState<Record<string,string>>({});
 const [report,setReport]=useState("");
 const [equipment,setEquipment]=useState("");
 const [severity,setSeverity]=useState("unknown");
 const [busy,setBusy]=useState(""),[feedback,setFeedback]=useState("");
 const retryPending=useCallback(async()=>{
  const operation=pendingRef.current;
  if(!operation||sending.current)return;
  sending.current=true;
  setBusy(operation.requestId??"report");
  setFeedback("Checking the saved submission…");
  try{
   // Each retry sends the *original* exact body, response and nonce. A
   // previous commit whose HTTP acknowledgement was lost is replayed by SQL,
   // never reported to the owner as a second staff incident.
   const receipt=await deliverCrewWithRetry(operation,async value=>{
    // The browser may sign out or switch accounts while a prior HTTP attempt
    // is uncertain. Never replay an old worker's saved report as a new user.
    const session=await createBrowserSupabaseClient().auth.getUser();
    if(session.error||session.data.user?.id!==authUserId)
     throw new Error("Original staff session no longer verified");
    // A stalled HTTP response is also an ambiguous save. Abort the wait and
    // replay exactly the same database-deduped nonce after bounded backoff.
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),20_000);
    try{
     const res=await fetch("/api/staff-channel",{method:"POST",
      credentials:"same-origin",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(value),signal:controller.signal});
     if(res.status===409){
      // Only a server-confirmed non-commit can release the outbox.
      // Generic conflicts (including a nonce collision) remain uncertain.
      const result=await res.json();
      if(result?.error==="stale_request")return {error:"stale_request"};
      throw new Error("Submission outcome uncertain");
     }
     if(!res.ok)throw new Error("Submission receipt unavailable");
     return await res.json();
    }finally{clearTimeout(timeout);}
   });
   if(receipt.status==="unconfirmed"){
    setFeedback("Delivery is not confirmed. Your original message is preserved in this tab. "+
     "Automatic retries used the same submission ID. Select Retry saved message to check again.");
    return;
   }
   if(receipt.status==="stale_request"){
    // Server verified that the *original* nonce has not committed and its
    // target request is no longer current. Keep any explanation as a separate
    // recoverable draft, but unblock the worker's other assignments.
    if(operation.body){
     try{window.sessionStorage.setItem(draftKey,operation.body);}catch{
      // The rendered draft remains available for copying in this tab.
     }
     setRejectedDraft(operation.body);
    }
    try{window.sessionStorage.removeItem(storageKey);}catch{
     // A stale record can only be retried idempotently on the same account.
    }
    pendingRef.current=null;
    setPending(false);
    setFeedback("That work request changed or closed. It was not saved. "+
     "Your explanation is preserved below as a draft; please review the updated work.");
    router.refresh();
    return;
   }
   try{window.sessionStorage.removeItem(storageKey);}catch{/* Replays stay idempotent. */}
   pendingRef.current=null;
   setPending(false);
   if(operation.requestId)setNotes(value=>({...value,[operation.requestId!]:""}));
   else {setReport("");setEquipment("");setSeverity("unknown");}
   setFeedback("Response saved. Your café supervisor can now review it.");
   router.refresh();
  }finally{sending.current=false;setBusy("");}
 },[router,storageKey,draftKey,authUserId]);
 useEffect(()=>{
  // Restore only in a scheduled callback, not synchronously inside React's
  // mount effect. The send handler independently checks storage before
  // generating a nonce, so a click during hydration cannot overwrite it.
  const scheduled=window.setTimeout(()=>{
   if(pendingRef.current)return;
   try{
    const draft=window.sessionStorage.getItem(draftKey);
    if(draft&&draft.length<=2000)setRejectedDraft(draft);
    const saved=loadCrewPending(window.sessionStorage,storageKey);
    if(saved){
     pendingRef.current=saved;
     setPending(true);
     setFeedback("Recovering a previously unconfirmed message…");
     void retryPending();
    }
   }catch{
    setFeedback("This browser cannot access pending messages. No message was sent.");
   }
  },0);
  return()=>window.clearTimeout(scheduled);
 },[retryPending,storageKey,draftKey]);
 function send(requestId:string|null,response:PendingCrewSubmission["response"],
  body:string|null){
  if(sending.current)return;
  try{
   // Check the durable tab outbox synchronously too: a click that arrives
   // before the mount recovery effect may NEVER overwrite an older nonce.
   const saved=pendingRef.current??loadCrewPending(window.sessionStorage,storageKey);
   const proposed:PendingCrewSubmission=saved??{
    requestId,response,body,nonce:crypto.randomUUID()};
   const operation=sameCrewOperation(saved,proposed);
   if(!saved)saveCrewPending(window.sessionStorage,storageKey,operation);
   pendingRef.current=operation;
   setPending(true);
   void retryPending();
  }catch{
   setFeedback("Cannot safely recover this browser's pending message. No new message was sent.");
  }
 }
 async function signOut(){
  await createBrowserSupabaseClient().auth.signOut();
  window.location.assign("/crew/login");
 }
 return <div className="space-y-6">
  <header className="flex items-center justify-between gap-4">
   <div><p className="text-sm font-semibold text-ink-muted">AI CAFE · My work</p>
    <h1 className="text-3xl font-bold">Hello, {name}</h1></div>
   <button type="button" onClick={signOut} className="rounded-full border border-line px-4 py-3 text-sm">Sign out</button>
  </header>
  <p className="rounded-2xl bg-card p-4 text-ink-muted">You can respond to work assigned to you and send a report. This is not the owner&apos;s AI chat.</p>
  {feedback&&<p role="status" className="rounded-xl border border-line bg-card p-3">{feedback}</p>}
  {rejectedDraft&&<div className="rounded-xl border border-line bg-card p-3">
   <p className="font-semibold">Unsent explanation from a changed work request</p>
   <p className="mt-2 whitespace-pre-wrap break-words">{rejectedDraft}</p>
   <div className="mt-3 flex flex-wrap gap-2">
    <button type="button" disabled={pending||report.length+(report?1:0)+rejectedDraft.length>2000} onClick={()=>{
     setReport(text=>(text?text+"\n":"")+rejectedDraft);
    }} className="min-h-12 rounded-full border border-line px-4 py-2 disabled:opacity-50">
     Add to report draft (not sent)
    </button>
    {report.length+(report?1:0)+rejectedDraft.length>2000&&<p className="text-sm">The draft is too long to combine; copy the explanation before continuing.</p>}
    <button type="button" onClick={()=>{
     try{window.sessionStorage.removeItem(draftKey);}catch{}
     setRejectedDraft("");
    }} className="min-h-12 rounded-full border border-line px-4 py-2">
     Dismiss saved explanation
    </button>
   </div>
  </div>}
  {pending&&<div className="rounded-xl border border-line bg-card p-3">
   <p className="text-sm">A previously submitted message is awaiting confirmation. Other submissions are paused to prevent duplicates.</p>
   <button type="button" disabled={Boolean(busy)} onClick={()=>void retryPending()}
    className="mt-2 min-h-12 rounded-full border border-line px-5 py-2 text-sm font-semibold disabled:opacity-50">
    Retry saved message
   </button>
  </div>}
  <section className="space-y-3" aria-labelledby="crew-assigned">
   <h2 id="crew-assigned" className="text-xl font-bold">Assigned to me</h2>
   {requests.length===0&&<p className="rounded-2xl bg-card p-4">No requests are waiting for you.</p>}
   {requests.map(req=><article key={req.id} className="space-y-3 rounded-2xl border border-line bg-card p-5">
    <div className="flex items-start justify-between gap-2"><h3 className="font-bold">{req.title}</h3>
     <span className="text-xs text-ink-muted">{req.status==="responded"?"Response received":"Needs response"}</span>
    </div>
    <p className="whitespace-pre-wrap">{req.prompt}</p>
    <label htmlFor={"note-"+req.id} className="block text-sm font-semibold">
     Add a message or explain your situation (optional with a button)
    </label>
    <textarea id={"note-"+req.id} rows={2} maxLength={2000} disabled={pending} value={notes[req.id]??""}
     onChange={e=>setNotes(v=>({...v,[req.id]:e.target.value}))}
     placeholder="For example: I can arrive at 8 AM, but not 7 AM."
     className="w-full rounded-xl border border-line bg-white p-3 text-ink"/>
    <div className="flex flex-wrap gap-2">
     {req.status==="open"&&(req.kind==="shift_confirmation"||req.kind==="coverage_offer"
      ?<><button disabled={Boolean(busy)||pending} onClick={()=>send(req.id,"confirm",notes[req.id]?.trim()||null)}
       className="min-h-12 rounded-full bg-accent px-5 py-2 font-semibold text-on-accent disabled:opacity-50">Confirm</button>
       <button disabled={Boolean(busy)||pending} onClick={()=>send(req.id,"decline",notes[req.id]?.trim()||null)}
        className="min-h-12 rounded-full border border-line px-5 py-2 font-semibold disabled:opacity-50">Cannot work</button></>
      :<button disabled={Boolean(busy)||pending} onClick={()=>send(req.id,"complete",notes[req.id]?.trim()||null)}
        className="min-h-12 rounded-full bg-accent px-5 py-2 font-semibold text-on-accent disabled:opacity-50">Mark complete</button>)}
     <button disabled={Boolean(busy)||pending||!notes[req.id]?.trim()}
      onClick={()=>send(req.id,"message",notes[req.id]?.trim()||null)}
      className="min-h-12 rounded-full border border-line px-5 py-2 font-semibold disabled:opacity-50">
      Send message
     </button>
    </div>
   </article>)}
  </section>
  <section className="space-y-3 rounded-2xl border border-line bg-card p-5">
   <h2 className="text-xl font-bold">Report an issue</h2>
   <label htmlFor="crew-report" className="text-sm">Tell Supervisor about a problem or something you noticed at work.</label>
   <textarea id="crew-report" rows={4} maxLength={2000} required disabled={pending} value={report}
    onChange={e=>setReport(e.target.value)} placeholder="Describe what you noticed…"
    className="w-full rounded-xl border border-line bg-white p-3 text-ink"/>
   <label className="block text-sm">Equipment name (optional, for maintenance reports)
    <input value={equipment} onChange={e=>setEquipment(e.target.value.replace(/[\r\n]/g," "))} maxLength={120}
     disabled={pending} className="mt-1 w-full rounded-xl border border-line p-3"/>
   </label>
   {equipment.trim()&&<label className="block text-sm">Urgency
    <select value={severity} onChange={e=>setSeverity(e.target.value)} disabled={pending}
     className="mt-1 w-full rounded-xl border border-line p-3">
     <option value="unknown">Not sure</option><option value="normal">Normal</option>
     <option value="high">High</option><option value="critical">Critical</option>
    </select>
   </label>}
   {equipment.trim()&&report.trim().length>1200&&<p className="text-sm">Maintenance reports must be 1200 characters or fewer.</p>}
   <button disabled={Boolean(busy)||pending||!report.trim()||Boolean(equipment.trim()&&report.trim().length>1200)}
    onClick={()=>send(null,"report",equipment.trim()?["Maintenance report v1",equipment.trim(),severity,report.trim()].join("\n"):report.trim())}
    className="min-h-12 rounded-full bg-accent px-5 py-2 font-semibold text-on-accent disabled:opacity-50">Send report</button>
  </section>
  <section className="space-y-3" aria-labelledby="crew-history">
   <h2 id="crew-history" className="text-xl font-bold">My messages</h2>
   {messages.length===0?<p className="text-ink-muted">You have not sent a message yet.</p>:
    <ul className="space-y-2">{messages.map(m=><li key={m.id} className="rounded-xl border border-line bg-card p-4">
     <p className="text-sm font-semibold capitalize">{m.actor==="owner"?"Message from café owner":m.response_code.replace("_"," ")}</p>
     {m.body&&<p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>}
     <time className="mt-1 block text-xs text-ink-muted" dateTime={m.received_at}>{new Date(m.received_at).toLocaleString()}</time>
    </li>)}</ul>}
  </section>
 </div>;
}
