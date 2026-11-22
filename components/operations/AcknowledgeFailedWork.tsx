"use client";
import {useState} from "react";
import {useRouter} from "@/i18n/navigation";
export default function AcknowledgeFailedWork({taskId,label}:{taskId:string;label:string}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(false);
  const router=useRouter();
  async function handle(){
    if(busy)return;setBusy(true);setError(false);
    try{
      const response=await fetch("/api/ai/work/acknowledge",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({taskId}),
      });
      if(!response.ok)throw Error("unavailable");
      const result=await response.json() as {acknowledged:boolean};
      if(!result.acknowledged)throw Error("stale");
      router.refresh();
    }catch{setError(true);}
    finally{setBusy(false);}
  }
  return <div className="mt-2">
    <button type="button" disabled={busy} onClick={()=>void handle()}
      className="min-h-12 rounded-full border border-line px-4 font-bold text-ink disabled:opacity-50">
      {label}
    </button>
    {error&&<p role="alert" className="text-sm text-ink">Unable to mark this review as handled.</p>}
  </div>;
}
