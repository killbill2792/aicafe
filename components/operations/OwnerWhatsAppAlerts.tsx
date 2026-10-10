"use client";
import {useEffect,useState} from "react";

export default function OwnerWhatsAppAlerts({copy}:{
 copy:{title:string;description:string;enable:string;disable:string;loading:string;
  saved:string;error:string;verifiedPhone:string}
}){
 const [optedIn,setOptedIn]=useState(false);
 const [loading,setLoading]=useState(true);
 const [saving,setSaving]=useState(false);
 const [notice,setNotice]=useState("");
 useEffect(()=>{
  const ctl=new AbortController();
  void fetch("/api/ai/notifications",{signal:ctl.signal,cache:"no-store"})
   .then(async r=>{if(!r.ok)throw new Error();return r.json() as Promise<{optIn:boolean}>;})
   .then(x=>{if(!ctl.signal.aborted)setOptedIn(x.optIn);})
   .catch(()=>{if(!ctl.signal.aborted)setNotice(copy.error);})
   .finally(()=>{if(!ctl.signal.aborted)setLoading(false);});
  return ()=>ctl.abort();
 },[copy.error]);
 async function change(){
  if(saving)return;
  setSaving(true);setNotice("");
  try{
   const response=await fetch("/api/ai/notifications",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({optIn:!optedIn}),
   });
   if(!response.ok)throw new Error();
   const result=await response.json() as {optIn:boolean};
   setOptedIn(result.optIn);setNotice(copy.saved);
  }catch{setNotice(copy.error+" "+copy.verifiedPhone);}
  finally{setSaving(false);}
 }
 return <section className="rounded-2xl border border-[#D8C8B5] bg-card p-4">
  <h2 className="font-headline text-2xl font-bold text-ink">{copy.title}</h2>
  <p className="mt-2 text-[17px] leading-relaxed text-ink-muted">{copy.description}</p>
  <button type="button" onClick={()=>void change()} disabled={loading||saving}
   className="mt-3 min-h-12 rounded-full bg-ink px-5 text-[17px] font-bold text-paper disabled:opacity-50">
   {loading||saving?copy.loading:optedIn?copy.disable:copy.enable}
  </button>
  <p role="status" aria-live="polite" className="mt-2 text-[17px] text-ink-muted">{notice}</p>
 </section>;
}
