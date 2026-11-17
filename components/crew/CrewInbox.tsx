"use client";
import {useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";
import type {StaffMessage,StaffRequest} from "@/lib/staffCommunication/channel.server";
export default function CrewInbox({name,requests,messages}:{
 name:string;requests:StaffRequest[];messages:StaffMessage[];
}){
 const router=useRouter(),sending=useRef(false);
 const [notes,setNotes]=useState<Record<string,string>>({});
 const [report,setReport]=useState("");
 const [busy,setBusy]=useState(""),[feedback,setFeedback]=useState("");
 async function send(requestId:string|null,response:string,body:string|null){
  if(sending.current)return;
  sending.current=true;setBusy(requestId??"report");setFeedback("");
  try{
   const res=await fetch("/api/staff-channel",{method:"POST",credentials:"same-origin",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({requestId,response,body,nonce:crypto.randomUUID()})});
   if(!res.ok)throw new Error("Send not confirmed");
   if(requestId)setNotes(value=>({...value,[requestId]:""}));else setReport("");
   setFeedback("Response saved. Your café supervisor can now review it.");
   router.refresh();
  }catch{
   // A network timeout is ambiguous. Refresh rather than issuing a different
   // nonce and silently duplicating the worker's report.
   setFeedback("Could not verify the result. Refresh to check your messages before retrying.");
  }finally{sending.current=false;setBusy("");}
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
    <textarea id={"note-"+req.id} rows={2} maxLength={2000} value={notes[req.id]??""}
     onChange={e=>setNotes(v=>({...v,[req.id]:e.target.value}))}
     placeholder="For example: I can arrive at 8 AM, but not 7 AM."
     className="w-full rounded-xl border border-line bg-white p-3 text-ink"/>
    <div className="flex flex-wrap gap-2">
     {req.status==="open"&&(req.kind==="shift_confirmation"||req.kind==="coverage_offer"
      ?<><button disabled={Boolean(busy)} onClick={()=>send(req.id,"confirm",notes[req.id]?.trim()||null)}
       className="min-h-12 rounded-full bg-accent px-5 py-2 font-semibold text-on-accent disabled:opacity-50">Confirm</button>
       <button disabled={Boolean(busy)} onClick={()=>send(req.id,"decline",notes[req.id]?.trim()||null)}
        className="min-h-12 rounded-full border border-line px-5 py-2 font-semibold disabled:opacity-50">Cannot work</button></>
      :<button disabled={Boolean(busy)} onClick={()=>send(req.id,"complete",notes[req.id]?.trim()||null)}
        className="min-h-12 rounded-full bg-accent px-5 py-2 font-semibold text-on-accent disabled:opacity-50">Mark complete</button>)}
     <button disabled={Boolean(busy)||!notes[req.id]?.trim()}
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
   <textarea id="crew-report" rows={4} maxLength={2000} required value={report}
    onChange={e=>setReport(e.target.value)} placeholder="Describe what you noticed…"
    className="w-full rounded-xl border border-line bg-white p-3 text-ink"/>
   <button disabled={Boolean(busy)||!report.trim()}
    onClick={()=>send(null,"report",report.trim())}
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
