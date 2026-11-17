"use client";
import {useCallback,useEffect,useState} from "react";
import type {StaffCoordinationCase} from "@/lib/staffCoordination/cases.server";

type Person={id:string;name:string};
type Kind="leave"|"recruitment"|"onboarding";
type CasesResult={cases:StaffCoordinationCase[]};
type SaveResult={id:string;revision:number;state:string;effectApplied?:boolean};

/** This is an OWNER decision surface; the worker uses Task13C's /crew only.
 * A decision records authorization intent but DOES NOT execute a personnel effect. */
export default function StaffCoordinationPanel({people}:{people:Person[]}) {
 const [cases,setCases]=useState<StaffCoordinationCase[]>([]);
 const [kind,setKind]=useState<Kind>("leave");
 const [employee,setEmployee]=useState("");
 const [from,setFrom]=useState("");
 const [to,setTo]=useState("");
 const [role,setRole]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const load=useCallback(async()=>{
  const response=await fetch("/api/staff-coordination",{cache:"no-store"});
  if(!response.ok)throw new Error("Cannot load staff coordination cases");
  const result=await response.json() as CasesResult;
  setCases(result.cases);
 },[]);
 useEffect(()=>{void load().catch(()=>setError("Staff coordination is unavailable."));},[load]);
 async function post(body:Record<string,unknown>) {
  setBusy(true);setError("");setNotice("");
  try{
   const response=await fetch("/api/staff-coordination",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body),cache:"no-store",
   });
   const result=await response.json() as SaveResult|{error?:string};
   if(!response.ok)throw new Error(("error" in result&&result.error)||"Save failed");
   await load();
   setNotice("Saved. Supervisor still needs source evidence before marking work complete.");
  }catch(e){setError(e instanceof Error?e.message:"Save failed");}
  finally{setBusy(false);}
 }
 const employeeName=(id:string|null)=>people.find(p=>p.id===id)?.name??"Unknown employee";
 return <section className="rounded-xl border border-border bg-surface p-4 space-y-4"
  aria-label="Recruitment leave and onboarding coordination">
  <div>
   <h2 className="font-semibold text-fg">Staff coordination</h2>
   <p className="text-sm text-fg-muted">Track leave, recruitment and onboarding. Employee replies arrive through the existing Staff inbox. An owner decision never sends a message, changes a shift or hires anyone by itself.</p>
  </div>
  <form className="grid gap-3 sm:grid-cols-2" onSubmit={event=>{
   event.preventDefault();
   void post({action:"open",nonce:crypto.randomUUID(),kind,
    employeeId:kind==="recruitment"?null:employee||null,locationId:null,
    from:kind==="leave"?from||null:null,to:kind==="leave"?to||null:null,
    role:kind==="recruitment"?role.trim()||null:null});
  }}>
   <label className="text-sm text-fg">Case type
    <select className="w-full rounded-md border border-border bg-surface p-2"
     value={kind} onChange={event=>setKind(event.target.value as Kind)} disabled={busy}>
     <option value="leave">Employee leave</option>
     <option value="recruitment">Recruitment need</option>
     <option value="onboarding">New employee onboarding</option>
    </select>
   </label>
   {kind!=="recruitment"?<label className="text-sm text-fg">Employee
    <select className="w-full rounded-md border border-border bg-surface p-2"
      value={employee} onChange={event=>setEmployee(event.target.value)} required disabled={busy}>
     <option value="">Choose employee</option>
     {people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
    </select>
   </label>:<label className="text-sm text-fg">Role needed
    <input className="w-full rounded-md border border-border bg-surface p-2"
     value={role} onChange={event=>setRole(event.target.value)} maxLength={100}
     placeholder="e.g. weekend barista" disabled={busy}/>
   </label>}
   {kind==="leave"&&<>
    <label className="text-sm text-fg">First leave day
     <input className="w-full rounded-md border border-border bg-surface p-2"
      type="date" value={from} onChange={event=>setFrom(event.target.value)} required disabled={busy}/>
    </label>
    <label className="text-sm text-fg">Last leave day
     <input className="w-full rounded-md border border-border bg-surface p-2"
      type="date" value={to} min={from||undefined} onChange={event=>setTo(event.target.value)}
      required disabled={busy}/>
    </label>
   </>}
   <button className="rounded-md bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
    type="submit" disabled={busy}>Record coordination need</button>
  </form>
  <div className="flex items-center justify-between gap-3">
   <h3 className="font-semibold text-fg">Open and recent cases</h3>
   <button className="rounded-md border border-border px-3 py-1 text-sm text-fg"
    type="button" disabled={busy} onClick={()=>void load().catch(()=>setError("Refresh failed"))}>Refresh</button>
  </div>
  {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  {notice&&<p role="status" className="text-sm text-fg">{notice}</p>}
  {!cases.length&&<p className="text-sm text-fg-muted">No coordination cases recorded.</p>}
  <ul className="space-y-3">{cases.map(item=><li key={item.id}
   className="rounded-md border border-border p-3 space-y-2 text-sm text-fg">
   <div className="font-medium">{item.case_kind==="intake"?"Employee message to investigate":
     item.case_kind==="leave"?"Leave request":
     item.case_kind==="recruitment"?"Recruitment need":"Onboarding coordination"} — {item.state.replaceAll("_"," ")}</div>
   {item.employee_id&&<p>{employeeName(item.employee_id)}</p>}
   {item.from_date&&<p>{item.from_date} to {item.to_date}</p>}
   {item.role_needed&&<p>Role: {item.role_needed}</p>}
   {item.source_kind==="staff_message"&&<p className="text-fg-muted">Authenticated employee message; inspect the existing Staff reply inbox. It is not an approval.</p>}
   {item.state==="approved"&&<p className="text-fg-muted">Owner authorized the next step. A real effect and verified source receipt are still required.</p>}
   {item.state==="needs_owner_decision"&&<div className="flex flex-wrap gap-2">
    <button type="button" disabled={busy}
     className="rounded-md border border-border px-3 py-1"
     onClick={()=>void post({action:"decide",caseId:item.id,revision:item.revision,choice:"approve"})}>
     Approve next step (no automatic effect)</button>
    <button type="button" disabled={busy}
     className="rounded-md border border-border px-3 py-1"
     onClick={()=>void post({action:"decide",caseId:item.id,revision:item.revision,choice:"decline"})}>
     Decline</button>
   </div>}
  </li>)}</ul>
 </section>;
}
