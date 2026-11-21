"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
type Employee={id:string;name:string;active:boolean;linked:boolean};
export default function StaffLoginLinkPanel(){
 const router=useRouter();
 const [people,setPeople]=useState<Employee[]>([]);
 const [chosen,setChosen]=useState(""),[email,setEmail]=useState("");
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 async function reload(){
  const res=await fetch("/api/staff-channel/link",{cache:"no-store"});
  if(!res.ok)throw new Error("Could not read account links");
  const body=await res.json() as {employees:Employee[]};
  setPeople(body.employees);setChosen(old=>old||body.employees.find(e=>e.active)?.id||"");
 }
 useEffect(()=>{
  let active=true;
  void fetch("/api/staff-channel/link",{cache:"no-store"})
   .then(async res=>{
    if(!res.ok)throw new Error("unavailable");
    return res.json() as Promise<{employees:Employee[]}>;
   }).then(body=>{
    if(active){
     setPeople(body.employees);
     setChosen(body.employees.find(e=>e.active)?.id??"");
    }
   }).catch(()=>{if(active)setMessage("Staff accounts are unavailable.");});
  return ()=>{active=false;};
 },[]);
 async function createLogin(){
  if(!chosen||!email.trim()||password.length<12)return;
  setBusy(true);setMessage("");
  try{
   const res=await fetch("/api/staff-channel/link",{method:"POST",
    headers:{"Content-Type":"application/json"},credentials:"same-origin",
    body:JSON.stringify({action:"create",employeeId:chosen,email:email.trim(),password})});
   if(!res.ok)throw new Error("create_failed");
   setPassword("");setEmail("");
   await reload();router.refresh();
   setMessage("Staff login created and linked. Share the My work sign-in link and password separately. The password is not stored here.");
  }catch{
   setMessage("Could not create this login. Check the email is unused and the employee is active. If an account already exists, link it below.");
  }finally{setBusy(false);}
 }
 async function update(unlink=false){
  if(!chosen||(!unlink&&!email.trim()))return;
  setBusy(true);setMessage("");
  try{
   const res=await fetch("/api/staff-channel/link",{method:"POST",
    headers:{"Content-Type":"application/json"},credentials:"same-origin",
    body:JSON.stringify({employeeId:chosen,email:unlink?null:email.trim()})});
   if(!res.ok)throw new Error("Account not linked");
   await reload();setEmail("");
   setMessage(unlink?"Staff login disconnected.":"Existing confirmed login linked.");
   // Refresh the owner read surface and reply composer without a manual reload.
   router.refresh();
  }catch{setMessage("Could not update the link. Check the login is already created and confirmed, and not in use.");}
  finally{setBusy(false);}
 }
 const selected=people.find(p=>p.id===chosen);
 return <section className="mt-5 space-y-3 rounded-3xl border border-line bg-card p-5">
  <h2 className="text-xl font-semibold text-ink">Employee login access</h2>
  <p className="text-sm text-ink-muted">Create an employee-only login or link an existing confirmed account. Share the <Link href="/crew/login" className="underline">My work sign-in link</Link> separately from the password. Employees cannot access the owner Supervisor or café data.</p>
  <button type="button" className="min-h-12 rounded-full border border-line px-4 text-sm"
   onClick={async()=>{
    try{
     await navigator.clipboard.writeText(window.location.origin+"/crew/login");
     setMessage("Staff sign-in link copied. Share the password separately.");
    }catch{setMessage("Use the My work sign-in link above. Never put passwords in a URL.");}
   }}>Copy staff sign-in link</button>
  <label htmlFor="staff-account-person" className="block text-sm font-semibold">Employee</label>
  <select id="staff-account-person" value={chosen} onChange={e=>setChosen(e.target.value)}
   className="min-h-12 w-full rounded-xl border border-line bg-white p-3">
   {people.filter(p=>p.active||p.linked).map(p=><option key={p.id} value={p.id}>
    {p.name} {p.linked?"(linked)":""} {!p.active?"(inactive)":""}
   </option>)}
  </select>
  <label htmlFor="staff-account-email" className="block text-sm font-semibold">Employee login email</label>
  <input id="staff-account-email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
   placeholder="Employee account email" autoComplete="off"
   className="min-h-12 w-full rounded-xl border border-line bg-white p-3"/>
  <label htmlFor="staff-account-password" className="block text-sm font-semibold">New password (12 characters minimum)</label>
  <input id="staff-account-password" type="password" value={password} autoComplete="new-password"
   onChange={e=>setPassword(e.target.value)} maxLength={128} placeholder="Set employee password"
   className="min-h-12 w-full rounded-xl border border-line bg-white p-3"/>
  <div className="flex flex-wrap gap-2">
   <button disabled={busy||!selected?.active||selected?.linked||!email.trim()||password.length<12}
    onClick={()=>void createLogin()} className="min-h-12 rounded-full bg-accent px-5 text-on-accent disabled:opacity-50">
    Create employee login
   </button>
   <button disabled={busy||!selected?.active||!email.trim()} onClick={()=>update()}
    className="min-h-12 rounded-full bg-accent px-5 text-on-accent disabled:opacity-50">Link existing login</button>
   {selected?.linked&&<button disabled={busy} onClick={()=>update(true)}
    className="min-h-12 rounded-full border border-line px-5 disabled:opacity-50">Disconnect login</button>}
  </div>
  {message&&<p role="status" className="text-sm text-ink-muted">{message}</p>}
 </section>;
}
