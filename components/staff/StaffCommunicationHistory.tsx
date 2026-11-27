"use client";
import {useState} from "react";
import en from "@/messages/en.json";
const copy=en.StaffChannelHistory;
const responseCopyKeys={confirm:"responseConfirm",decline:"responseDecline",complete:"responseComplete",
 message:"responseMessage",report:"responseReport"} as const;
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
  }catch{setError(copy.historyError);}
  finally{setBusy(false);}
 }
 function describe(e:OwnerStaffHistoryEvent){
  if(e.kind==="request")return e.actor==="owner"?copy.ownerRequested:copy.assignedRequest;
  if(e.actor==="employee")return e.responseCode==="report"?copy.employeeReported:copy.employeeReplied;
  return e.actor==="owner"?copy.ownerReplied:copy.supervisorReplied;
 }
 return <section aria-label={copy.historyAria}>
  <p className="text-sm text-ink-muted">{copy.historyHelp}</p>
  {events.length===0?<p className="mt-3 text-sm text-ink-muted">{copy.emptyHistory}</p>:
   <ol className="mt-3 space-y-3">{events.map(e=><li key={e.kind+":"+e.id}
    className="rounded-xl border border-line p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
     <strong className="text-sm">{e.employeeName} · {describe(e)}</strong>
     <time className="text-xs text-ink-muted" dateTime={e.at}>
      {new Date(e.at).toLocaleString()}</time>
    </div>
    {e.requestTitle&&<p className="text-xs text-ink-muted">{e.requestTitle}</p>}
    {e.kind==="message"&&e.actor==="employee"&&e.responseCode&&<p className="mt-2 text-sm font-semibold">
     {copy[responseCopyKeys[e.responseCode as keyof typeof responseCopyKeys]??"responseUnknown"]}</p>}
    {e.text&&<p className="mt-2 whitespace-pre-wrap wrap-break-word text-sm">{e.text}</p>}
    {e.kind==="request"&&e.status&&<p className="mt-1 text-xs text-ink-muted">
     {copy.requestStatus}: {e.status}</p>}
   </li>)}</ol>}
  {cursor&&<button type="button" disabled={busy} onClick={()=>void loadOlder()}
   className="mt-3 min-h-12 rounded-full border border-line px-5 text-sm font-semibold disabled:opacity-50">
   {busy?copy.loading:copy.loadOlder}
  </button>}
  {error&&<p role="alert" className="mt-2 text-sm text-warn">{error}</p>}
 </section>;
}
