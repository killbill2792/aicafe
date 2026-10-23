"use client";
import {useState} from "react";
import {useRouter} from "next/navigation";
import Link from "next/link";
type Code={id:string;code_hint:string;duration_months:number|null;fixed_end_date:string|null;max_cafes:number;redeemed_cafes:number;note:string|null;active:boolean;created_at:string};
type Redemption={code_id:string;business_id:string;redeemed_by:string|null;redeemed_at:string;access_end:string;ownerEmail:string;cafeName:string;codeHint:string};
type Access={business_id:string;mode:string;code_id:string|null;access_end:string|null};
type Cafe={id:string;name:string};
export default function CodeConsole({codes,redemptions,access,cafes,page,perPage,codeTotal,cafePage,cafePerPage,cafeTotal}:{codes:Code[];redemptions:Redemption[];access:Access[];cafes:Cafe[];page:number;perPage:number;codeTotal:number;cafePage:number;cafePerPage:number;cafeTotal:number}){
 const router=useRouter();
 const [durationKind,setDurationKind]=useState("months");
 const [code,setCode]=useState("");
 const [months,setMonths]=useState(3);
 const [end,setEnd]=useState("");
 const [max,setMax]=useState(1);
 const [note,setNote]=useState("");
 const [revealed,setRevealed]=useState("");
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 async function action(data:Record<string,unknown>){
  setBusy(true);setError("");
  try{
   const res=await fetch("/api/admin/codes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
   const json=await res.json();
   if(!res.ok)throw new Error(json.error??"Request failed");
   if(json.code)setRevealed(String(json.code));
   router.refresh();
  }catch(e){setError(e instanceof Error?e.message:"Request failed");}
  finally{setBusy(false);}
 }
 const pageUrl=(codeIndex:number,cafeIndex:number)=>"/admin/codes?page="+codeIndex+"&cafePage="+cafeIndex;
 return <section className="space-y-7">
  <div><h1 className="text-2xl font-bold">Free access codes</h1><p className="text-sm text-slate-600">No payments. Codes are stored as hashes; copy a new code when it is created.</p></div>
  {error&&<p role="alert" className="rounded border border-red-400 p-3 text-red-700">{error}</p>}
  {revealed&&<div className="rounded border border-amber-400 bg-amber-50 p-4"><p className="font-bold">New code — shown only once</p><code className="select-all text-xl">{revealed}</code><button className="ms-3 underline" onClick={()=>{navigator.clipboard.writeText(revealed)}}>Copy</button><button className="ms-3 underline" onClick={()=>setRevealed("")}>Dismiss</button></div>}
  <form className="grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void action({
    action:"create",code:code||undefined,durationMonths:durationKind==="months"?months:null,
    fixedEndDate:durationKind==="fixed"?end:null,maxCafes:max,note,
  });}}>
   <h2 className="sm:col-span-2 font-bold">Create code</h2>
   <label className="grid gap-1 text-sm">Custom code (optional)<input className="rounded border p-2" value={code} onChange={e=>setCode(e.target.value)} maxLength={32} placeholder="Generated if blank"/></label>
   <label className="grid gap-1 text-sm">Grant type<select className="rounded border p-2" value={durationKind} onChange={e=>setDurationKind(e.target.value)}><option value="months">Months from redeem</option><option value="fixed">Fixed end date</option></select></label>
   {durationKind==="months"?<label className="grid gap-1 text-sm">Months<input className="rounded border p-2" type="number" min="1" max="120" value={months} onChange={e=>setMonths(Number(e.target.value))}/></label>:
     <label className="grid gap-1 text-sm">End date (inclusive)<input className="rounded border p-2" required type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>}
   <label className="grid gap-1 text-sm">Maximum cafés<input className="rounded border p-2" type="number" min="1" max="100000" value={max} onChange={e=>setMax(Number(e.target.value))}/></label>
   <label className="grid gap-1 text-sm sm:col-span-2">Internal note<input className="rounded border p-2" value={note} onChange={e=>setNote(e.target.value)} maxLength={500}/></label>
   <button disabled={busy} className="rounded bg-slate-900 p-2 text-white sm:col-span-2">Create code</button>
  </form>
  <div className="overflow-x-auto rounded border bg-white"><table className="w-full text-left text-sm">
   <thead><tr className="bg-slate-100">{["Code hint","Grant","Limit","Redeemed cafés","Note","Active"].map(x=><th key={x} className="p-3">{x}</th>)}</tr></thead>
   <tbody>{codes.map(c=><tr className="border-t" key={c.id}><td className="p-3"><Link href={"/admin/codes/"+c.id} className="underline">{c.code_hint}</Link></td>
    <td className="p-3">{c.duration_months?c.duration_months+" months":"Until "+c.fixed_end_date}</td><td className="p-3">{c.max_cafes}</td>
    <td className="p-3">{c.redeemed_cafes}</td><td className="p-3">{c.note??"—"}</td>
    <td className="p-3"><button disabled={busy} className="underline" onClick={()=>void action({action:"toggle",id:c.id,active:!c.active})}>{c.active?"Deactivate":"Activate"}</button></td></tr>)}</tbody>
  </table></div>
  <nav className="flex gap-4 text-[17px]" aria-label="Code pages">
   {page>0&&<Link className="underline" href={pageUrl(page-1,cafePage)}>Previous codes</Link>}
   {(page+1)*perPage<codeTotal&&<Link className="underline" href={pageUrl(page+1,cafePage)}>Next codes</Link>}
  </nav>
  <h2 className="text-xl font-bold">Recent redemptions</h2>
  <div className="overflow-x-auto rounded border bg-white"><table className="w-full text-left text-sm">
   <thead><tr className="bg-slate-100">{["Café","Owner","Code","Redeemed","Grant end","Current access end"].map(x=><th className="p-3" key={x}>{x}</th>)}</tr></thead>
   <tbody>{redemptions.map(r=><tr key={r.code_id+r.business_id} className="border-t">
    <td className="p-3">{r.cafeName}</td><td className="p-3">{r.ownerEmail}</td>
    <td className="p-3">{r.codeHint}</td>
    <td className="p-3">{r.redeemed_at.slice(0,10)}</td><td className="p-3">{r.access_end}</td>
    <td className="p-3">{access.find(a=>a.business_id===r.business_id)?.access_end??"Grandfathered"}</td></tr>)}</tbody>
  </table></div>
  <h2 className="text-xl font-bold">Café access control</h2>
  <p className="text-[17px]">{cafeTotal} cafés · page {cafePage+1} of {Math.max(1,Math.ceil(cafeTotal/cafePerPage))}</p>
  <div className="space-y-2">{cafes.map(c=>{const state=access.find(a=>a.business_id===c.id);return <div key={c.id} className="flex flex-wrap items-center gap-3 rounded border bg-white p-3 text-sm">
   <strong>{c.name}</strong><span>{state?.mode??"grandfathered"} {state?.access_end??""}</span>
   <form className="flex items-center gap-2" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void action({action:"extend",businessId:c.id,accessEnd:form.get("end")});}}>
    <label>Extend until <input name="end" type="date" required className="rounded border p-1"/></label>
    <button disabled={busy} className="underline">Extend</button>
   </form>
   <button disabled={busy} className="underline" onClick={()=>void action({action:"setMode",businessId:c.id,mode:"grandfathered"})}>Full access</button>
   <button disabled={busy} className="underline" onClick={()=>void action({action:"setMode",businessId:c.id,mode:"paused"})}>Pause AI</button>
  </div>})}</div>
  <nav className="flex gap-4 text-[17px]" aria-label="Café access pages">
   {cafePage>0&&<Link className="underline" href={pageUrl(page,cafePage-1)}>Previous cafés</Link>}
   {(cafePage+1)*cafePerPage<cafeTotal&&<Link className="underline" href={pageUrl(page,cafePage+1)}>Next cafés</Link>}
  </nav>
 </section>;
}
