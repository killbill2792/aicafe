"use client";
import {useRef,useState} from "react";
import {useRouter} from "next/navigation";
export default function StaffReplyComposer({people}:{
 people:readonly {id:string;name:string}[];
}){
 const [employeeId,setEmployeeId]=useState(people[0]?.id??"");
 const [body,setBody]=useState(""),[status,setStatus]=useState("");
 const [busy,setBusy]=useState(false),nonce=useRef<string|null>(null);
 const router=useRouter();
 async function send(){
  if(!employeeId||!body.trim()||busy)return;
  setBusy(true);setStatus("");
  // If HTTP fails without a receipt, reuse the same nonce to avoid duplicate
  // employee notifications on a network replay.
  const requestNonce=nonce.current??crypto.randomUUID();
  nonce.current=requestNonce;
  try{
   const response=await fetch("/api/staff-channel/owner-message",{
    method:"POST",credentials:"same-origin",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({employeeId,body:body.trim(),nonce:requestNonce}),
   });
   if(!response.ok)throw new Error("unverified");
   nonce.current=null;setBody("");
   setStatus("Message saved to this employee's work inbox. Not a read or delivery receipt.");
   router.refresh();
  }catch{setStatus("Unable to verify the send. Retry with the same message or refresh to check the record.");}
  finally{setBusy(false);}
 }
 return <section className="space-y-3 rounded-2xl border border-line p-4">
  <h3 className="font-semibold">Message an employee</h3>
  <p className="text-sm text-ink-muted">Your Send click shares a message in the worker's private web inbox. This does not send WhatsApp or confirm staff attendance.</p>
  {!people.length?<p className="text-sm text-ink-muted">Link an existing employee account before sending a message.</p>:<>
   <label className="block text-sm font-semibold" htmlFor="staff-reply-person">Employee</label>
   <select id="staff-reply-person" className="min-h-12 w-full rounded-xl border border-line bg-white p-3"
    value={employeeId} onChange={e=>{setEmployeeId(e.target.value);nonce.current=null;}}>
    {people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
   </select>
   <label className="block text-sm font-semibold" htmlFor="staff-reply-body">Message</label>
   <textarea id="staff-reply-body" rows={3} maxLength={2000}
    placeholder="For example: Thanks for the update. Can you confirm 8 AM?"
    value={body} onChange={e=>{setBody(e.target.value);nonce.current=null;}}
    className="w-full rounded-xl border border-line bg-white p-3"/>
   <button type="button" disabled={busy||!body.trim()}
    onClick={send} className="min-h-12 rounded-full bg-accent px-5 font-semibold text-on-accent disabled:opacity-50">
    {busy?"Saving…":"Send to employee"}
   </button>
  </>}
  {status&&<p role="status" className="text-sm text-ink-muted">{status}</p>}
 </section>;
}
