"use client";
import {useState} from "react";
import {useRouter} from "next/navigation";
import {redeemFailureMessage,type RedemptionCopy} from "@/lib/access/redemptionCopy";
export default function RedeemCodeForm({copy}:{copy:RedemptionCopy & {label:string;placeholder:string;submit:string;success:string}}){
 const router=useRouter();const [code,setCode]=useState("");const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");const [error,setError]=useState(false);
 return <form className="mt-4 flex flex-wrap gap-3" onSubmit={async e=>{
  e.preventDefault();setBusy(true);setMessage("");
  try{
   const res=await fetch("/api/access/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});
   const json=await res.json();setError(!res.ok);
   setMessage(res.ok?copy.success+" "+json.access_end:redeemFailureMessage(json.status??json.error,copy));
   if(res.ok){setCode("");router.refresh();}
  }catch{setError(true);setMessage(copy.error);}finally{setBusy(false);}
 }}>
  <label className="w-full text-[17px] font-semibold">{copy.label}</label>
  <input dir="ltr" autoComplete="off" className="min-h-12 min-w-0 flex-1 rounded border px-3 py-2 text-[17px] text-ink" value={code} maxLength={64} placeholder={copy.placeholder} onChange={e=>setCode(e.target.value)} required/>
  <button disabled={busy} className="min-h-12 rounded bg-ink px-4 py-2 text-[17px] font-semibold text-white disabled:opacity-60">{copy.submit}</button>
  {message&&<p role={error?"alert":"status"} className="w-full text-[17px] leading-relaxed">{message}</p>}
 </form>;
}
