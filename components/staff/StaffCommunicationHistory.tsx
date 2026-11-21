"use client";
import {useState} from "react";
import type {OwnerStaffHistoryPage,OwnerStaffHistoryEvent} from "@/lib/staffCommunication/channel.server";
/** Existing Staff screen only. Actual saved messages/requests, not a new chat. */
export default function StaffCommunicationHistory({initial}:{
 initial:OwnerStaffHistoryPage;
}){
 const [events,setEvents]=useState(initial.events);
 const [cursor,setCursor]=useState(initial.nextCursor);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 async function loadOlder(){
  if(!cursor||busy)return;
  setBusy(true);setError("");
  try{
   const q=new URLSearchParams({at:cursor.at,id:cursor.id});
   const res=await fetch("/api/staff-channel/owner-history?"+q.toString(),{
    cache:"no-store",credentials:"same-origin"});
   if(!res.ok)throw new Error("history_unavailable");
   const body=await res.json() as OwnerStaffHistoryPage;
   const keys=new Set(events.map(e=>e.kind+":"+e.id));
   setEvents(old=>[...old,...body.events.filter(e=>!keys.has(e.kind+":"+e.id))]);
   setCursor(body.nextCursor);
  }catch{setError("Could not load older messages. Try again.");}
  finally{setBusy(false);}
 }
 function describe(e:OwnerStaffHistoryEvent){
  if(e.kind==="request")return e.actor==="owner"?"Owner requested":"Assigned work request";
  if(e.actor==="employee")return e.responseCode==="report"?"Employee reported":"Employee replied";
  return e.actor==="owner"?"Owner replied":"Supervisor replied";
 }
 return <section aria-label="Employee Supervisor communication history">
  <p className="text-sm text-ink-muted">Every saved staff question and reply is available here, including older exchanges.
   A reply is employee-reported information, not proof of a schedule or inventory change.</p>
  {events.length===0?<p className="mt-3 text-sm text-ink-muted">No staff communications yet.</p>:
   <ol className="mt-3 space-y-3">{events.map(e=><li key={e.kind+":"+e.id}
    className="rounded-xl border border-line p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
     <strong className="text-sm">{e.employeeName} · {describe(e)}</strong>
     <time className="text-xs text-ink-muted" dateTime={e.at}>
      {new Date(e.at).toLocaleString()}</time>
    </div>
    {e.requestTitle&&<p className="text-xs text-ink-muted">{e.requestTitle}</p>}
    {e.text&&<p className="mt-2 whitespace-pre-wrap break-words text-sm">{e.text}</p>}
    {e.kind==="request"&&e.status&&<p className="mt-1 text-xs text-ink-muted">
     Request status: {e.status}</p>}
   </li>)}</ol>}
  {cursor&&<button type="button" disabled={busy} onClick={()=>void loadOlder()}
   className="mt-3 min-h-12 rounded-full border border-line px-5 text-sm font-semibold disabled:opacity-50">
   {busy?"Loading…":"Load older exchanges"}
  </button>}
  {error&&<p role="alert" className="mt-2 text-sm text-warn">{error}</p>}
 </section>;
}
