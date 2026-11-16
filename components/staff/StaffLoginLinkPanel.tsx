"use client";
import {useEffect,useState} from "react";
type Employee={id:string;name:string;active:boolean;linked:boolean};
export default function StaffLoginLinkPanel(){
 const [people,setPeople]=useState<Employee[]>([]);
 const [chosen,setChosen]=useState(""),[email,setEmail]=useState("");
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 async function reload(){
  const res=await fetch("/api/staff-channel/link",{cache:"no-store"});
  if(!res.ok)throw new Error("Could not read account links");
  const body=await res.json() as {employees:Employee[]};
  setPeople(body.employees);setChosen(old=>old||body.employees.find(e=>e.active)?.id||"");
 }
 useEffect(()=>{void reload().catch(()=>setMessage("Staff accounts are unavailable."));},[]);
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
  }catch{setMessage("Could not update the link. Check the login is already created and confirmed, and not in use.");}
  finally{setBusy(false);}
 }
 const selected=people.find(p=>p.id===chosen);
 return <section className="mt-5 space-y-3 rounded-3xl border border-line bg-card p-5">
  <h2 className="text-xl font-semibold text-ink">Employee login access</h2>
  <p className="text-sm text-ink-muted">Link an account you already created for this employee. Employees only see <a href="/crew/login" className="underline">their own work screen</a>—not the owner Supervisor or café data.</p>
  <label htmlFor="staff-account-person" className="block text-sm font-semibold">Employee</label>
  <select id="staff-account-person" value={chosen} onChange={e=>setChosen(e.target.value)}
   className="min-h-12 w-full rounded-xl border border-line bg-white p-3">
   {people.filter(p=>p.active).map(p=><option key={p.id} value={p.id}>{p.name} {p.linked?"(linked)":""}</option>)}
  </select>
  <label htmlFor="staff-account-email" className="block text-sm font-semibold">Existing confirmed login email</label>
  <input id="staff-account-email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
   placeholder="Employee account email" autoComplete="off"
   className="min-h-12 w-full rounded-xl border border-line bg-white p-3"/>
  <div className="flex flex-wrap gap-2">
   <button disabled={busy||!selected||!email.trim()} onClick={()=>update()}
    className="min-h-12 rounded-full bg-accent px-5 text-on-accent disabled:opacity-50">Link existing login</button>
   {selected?.linked&&<button disabled={busy} onClick={()=>update(true)}
    className="min-h-12 rounded-full border border-line px-5 disabled:opacity-50">Disconnect login</button>}
  </div>
  {message&&<p role="status" className="text-sm text-ink-muted">{message}</p>}
 </section>;
}
