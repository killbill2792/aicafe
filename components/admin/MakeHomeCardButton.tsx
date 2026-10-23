"use client";
import {useState} from "react";
export default function MakeHomeCardButton({topic,alreadySuggested}:{topic:string;alreadySuggested:boolean}){
  const [saved,setSaved]=useState(alreadySuggested),[working,setWorking]=useState(false),[error,setError]=useState(false);
  async function save(){
    setWorking(true);setError(false);
    try {
      const response=await fetch("/api/admin/home-card-suggestions",{
        method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({topic}),
      });
      if(!response.ok)throw new Error("save_failed");
      setSaved(true);
    }catch{setError(true);}finally{setWorking(false);}
  }
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" onClick={()=>void save()} disabled={saved||working}
      className="min-h-12 rounded-lg border border-blue-700 px-3 font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
      {saved?"Suggestion saved":working?"Saving…":"Make it a Home card"}
    </button>
    {saved&&<span className="text-xs text-slate-600" role="status">Suggestion only — not published</span>}
    {error&&<span role="alert" className="text-sm text-red-700">Could not save suggestion.</span>}
  </div>;
}
