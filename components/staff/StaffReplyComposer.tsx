"use client";
import {useCallback,useState} from "react";
import {useOwnerStaffOutbox} from "@/lib/staffCommunication/useOwnerStaffOutbox";
import type {OwnerPending} from "@/lib/staffCommunication/ownerPending";
export default function StaffReplyComposer({people,ownerUserId,businessId}:{
 people:readonly {id:string;name:string}[];ownerUserId:string;businessId:string;
}){
 const [employeeId,setEmployeeId]=useState(people[0]?.id??"");
 // A server refresh can add the first linked employee without remounting.
 const selectedEmployeeId=people.some(p=>p.id===employeeId)?employeeId:people[0]?.id??"";
 const [body,setBody]=useState("");
 const [workKind,setWorkKind]=useState<"task"|"checklist">("task");
 const [workTitle,setWorkTitle]=useState(""),[workPrompt,setWorkPrompt]=useState("");
 const restoreMessage=useCallback((operation:OwnerPending)=>{
  if(operation.type!=="message")return;
  setEmployeeId(operation.employeeId);setBody(operation.body);
 },[]);
 const confirmMessage=useCallback((operation:OwnerPending)=>{
  if(operation.type==="message")setBody("");
 },[]);
 const rejectMessage=useCallback((operation:OwnerPending)=>{
  if(operation.type==="message")setBody("");
 },[]);
 const restoreAssignment=useCallback((operation:OwnerPending)=>{
  if(operation.type!=="assignment")return;
  setEmployeeId(operation.employeeId);setWorkKind(operation.workKind);
  setWorkTitle(operation.title);setWorkPrompt(operation.prompt);
 },[]);
 const confirmAssignment=useCallback((operation:OwnerPending)=>{
  if(operation.type==="assignment"){setWorkTitle("");setWorkPrompt("");}
 },[]);
 const rejectAssignment=useCallback((operation:OwnerPending)=>{
  if(operation.type==="assignment"){setWorkTitle("");setWorkPrompt("");}
 },[]);
 const message=useOwnerStaffOutbox({
  type:"message",ownerUserId,businessId,endpoint:"/api/staff-channel/owner-message",
  onRestored:restoreMessage,onConfirmed:confirmMessage,onRejected:rejectMessage,
 });
 const assignment=useOwnerStaffOutbox({
  type:"assignment",ownerUserId,businessId,endpoint:"/api/staff-channel/owner-assignment",
  onRestored:restoreAssignment,onConfirmed:confirmAssignment,onRejected:rejectAssignment,
 });
 const pending=Boolean(message.pending||assignment.pending);
 const locked=pending||message.busy||assignment.busy;
 const ownerSend=()=>{
  if(locked||!selectedEmployeeId||!body.trim())return;
  message.submit({type:"message",employeeId:selectedEmployeeId,
   body:body.trim(),nonce:crypto.randomUUID()});
 };
 const ownerAssign=()=>{
  if(locked||!selectedEmployeeId||!workTitle.trim()||!workPrompt.trim())return;
  assignment.submit({type:"assignment",employeeId:selectedEmployeeId,
   workKind,title:workTitle.trim(),prompt:workPrompt.trim(),nonce:crypto.randomUUID()});
 };
 const worker=(id:string)=>people.find(p=>p.id===id)?.name??"previous employee";
 return <section className="space-y-3 rounded-2xl border border-line p-4">
  <h3 className="font-semibold">Message an employee</h3>
  <p className="text-sm text-ink-muted">Your Send click saves a private inbox message. It does not send WhatsApp or confirm staff attendance.</p>
  {message.pending&&<div role="status" className="space-y-2 rounded-xl border border-line p-3">
   <p className="text-sm font-semibold">Message awaiting a verified receipt for {worker(message.pending.employeeId)}</p>
   <p className="whitespace-pre-wrap break-words text-sm">{message.pending.type==="message"?message.pending.body:""}</p>
   <p className="text-sm">The original text and request identity are preserved through reloads. Do not create another message to replace it.</p>
   <button type="button" disabled={message.busy} onClick={()=>void message.retry()}
    className="min-h-12 rounded-full border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">
    Retry original message
   </button>
  </div>}
  {message.rejectedDraft?.type==="message"&&<div className="space-y-2 rounded-xl border border-line p-3">
   <p className="font-semibold">Unsent owner message saved as a draft</p>
   <p className="text-sm">The original employee lost access before a new message could be saved. Choose an active employee before reusing the wording.</p>
   <p className="whitespace-pre-wrap break-words">{message.rejectedDraft.body}</p>
   <div className="flex flex-wrap gap-2">
    <button type="button" disabled={locked} onClick={()=>{if(message.rejectedDraft?.type==="message")setBody(message.rejectedDraft.body);}}
     className="min-h-12 rounded-full border border-line px-4 py-2 disabled:opacity-50">Use wording in a new draft (not sent)</button>
    <button type="button" onClick={message.dismissDraft}
     className="min-h-12 rounded-full border border-line px-4 py-2">Dismiss saved draft</button>
   </div>
  </div>}
  {message.status&&<p role="status" className="text-sm text-ink-muted">{message.status}</p>}
  {!people.length?<p className="text-sm text-ink-muted">Link an existing employee account before sending a message.</p>:<>
   <label className="block text-sm font-semibold" htmlFor="staff-reply-person">Employee</label>
   <select id="staff-reply-person" className="min-h-12 w-full rounded-xl border border-line bg-white p-3"
    disabled={locked} value={selectedEmployeeId} onChange={e=>setEmployeeId(e.target.value)}>
    {people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
   </select>
   <label className="block text-sm font-semibold" htmlFor="staff-reply-body">Message</label>
   <textarea id="staff-reply-body" rows={3} maxLength={2000} disabled={locked}
    placeholder="For example: Thanks for the update. Can you confirm 8 AM?"
    value={body} onChange={e=>setBody(e.target.value)}
    className="w-full rounded-xl border border-line bg-white p-3"/>
   <button type="button" disabled={locked||!selectedEmployeeId||!body.trim()}
    onClick={ownerSend} className="min-h-12 rounded-full bg-accent px-5 font-semibold text-on-accent disabled:opacity-50">
    {message.busy?"Saving…":"Send to employee"}
   </button>
  </>}
  <div className="mt-5 space-y-3 border-t border-line pt-5">
   <h3 className="font-semibold">Assign staff work</h3>
   <p className="text-sm text-ink-muted">The employee inbox can receive work and checklists. This records an instruction, not completion.</p>
   {assignment.pending&&<div role="status" className="space-y-2 rounded-xl border border-line p-3">
    <p className="text-sm font-semibold">Assignment awaiting a verified receipt for {worker(assignment.pending.employeeId)}</p>
    {assignment.pending.type==="assignment"&&<>
     <p className="font-medium">{assignment.pending.title}</p>
     <p className="whitespace-pre-wrap break-words text-sm">{assignment.pending.prompt}</p>
    </>}
    <p className="text-sm">The original assignment and request identity are preserved through reloads.</p>
    <button type="button" disabled={assignment.busy} onClick={()=>void assignment.retry()}
     className="min-h-12 rounded-full border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">
     Retry original assignment
    </button>
   </div>}
   {assignment.rejectedDraft?.type==="assignment"&&<div className="space-y-2 rounded-xl border border-line p-3">
    <p className="font-semibold">Unsent owner assignment saved as a draft</p>
    <p className="text-sm">The original employee lost access before new work could be assigned. Choose an active employee before reviewing a new assignment.</p>
    <p className="font-medium">{assignment.rejectedDraft.title}</p>
    <p className="whitespace-pre-wrap break-words">{assignment.rejectedDraft.prompt}</p>
    <div className="flex flex-wrap gap-2">
     <button type="button" disabled={locked} onClick={()=>{
      if(assignment.rejectedDraft?.type==="assignment"){
       setWorkKind(assignment.rejectedDraft.workKind);
       setWorkTitle(assignment.rejectedDraft.title);
       setWorkPrompt(assignment.rejectedDraft.prompt);
      }
     }} className="min-h-12 rounded-full border border-line px-4 py-2 disabled:opacity-50">
      Use wording in a new draft (not sent)
     </button>
     <button type="button" onClick={assignment.dismissDraft}
      className="min-h-12 rounded-full border border-line px-4 py-2">Dismiss saved draft</button>
    </div>
   </div>}
   {assignment.status&&<p role="status" className="text-sm text-ink-muted">{assignment.status}</p>}
   <label htmlFor="staff-work-kind" className="block text-sm font-semibold">Type</label>
   <select id="staff-work-kind" className="min-h-12 w-full rounded-xl border border-line bg-white p-3"
    disabled={locked} value={workKind} onChange={e=>setWorkKind(e.target.value as "task"|"checklist")}>
    <option value="task">Task</option><option value="checklist">Checklist</option>
   </select>
   <label htmlFor="staff-work-title" className="block text-sm font-semibold">Work title</label>
   <input id="staff-work-title" maxLength={200} disabled={locked} value={workTitle}
    onChange={e=>setWorkTitle(e.target.value)}
    className="min-h-12 w-full rounded-xl border border-line bg-white p-3"/>
   <label htmlFor="staff-work-prompt" className="block text-sm font-semibold">What should they do?</label>
   <textarea id="staff-work-prompt" rows={3} maxLength={2000} disabled={locked}
    value={workPrompt} onChange={e=>setWorkPrompt(e.target.value)}
    className="w-full rounded-xl border border-line bg-white p-3"/>
   <button type="button" disabled={locked||!selectedEmployeeId||!workTitle.trim()||!workPrompt.trim()}
    onClick={ownerAssign} className="min-h-12 rounded-full bg-accent px-5 font-semibold text-on-accent disabled:opacity-50">
    {assignment.busy?"Saving…":"Assign work"}
   </button>
  </div>
 </section>;
}
