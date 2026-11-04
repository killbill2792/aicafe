"use client";
import {useState} from "react";
type Verdict={sent:boolean;step:string;reason:string;details?:Record<string,unknown>};
type Report={verdict:Verdict;settings:{name:string;on:boolean}[];migrationReady:boolean};
/** Admin only. Sends today's brief for the chosen café now, through the real path. */
export default function TestBriefButton({cafes,defaultCafeId}:{cafes:{id:string;name:string}[];defaultCafeId:string|null}){
  const [cafeId,setCafeId]=useState(defaultCafeId??cafes[0]?.id??"");
  const [working,setWorking]=useState(false),[report,setReport]=useState<Report|null>(null),
    [error,setError]=useState<string|null>(null);
  async function send(){
    setWorking(true);setError(null);setReport(null);
    try{
      const response=await fetch("/api/admin/briefs/test",{method:"POST",credentials:"same-origin",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({businessId:cafeId})});
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body?.verdict)throw new Error(body?.error??"test_brief_failed");
      setReport(body as Report);
    }catch(e){setError(e instanceof Error?e.message:"test_brief_failed");}
    finally{setWorking(false);}
  }
  return <section className="space-y-3 rounded-xl border bg-white p-5">
    <h2 className="font-semibold">Send test brief now</h2>
    <p className="text-sm text-slate-600">Goes through the real send path and skips only the time-of-day rule.
      It sends today&apos;s brief, so the scheduled one will not send again today.</p>
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm" htmlFor="brief-cafe">Café</label>
      <select id="brief-cafe" value={cafeId} onChange={e=>setCafeId(e.target.value)}
        className="min-h-12 rounded-lg border px-3">
        {cafes.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" onClick={()=>void send()} disabled={!cafeId||working}
        className="min-h-12 rounded-lg bg-blue-700 px-4 font-semibold text-white disabled:opacity-60">
        {working?"Sending…":"Send test brief now"}
      </button>
    </div>
    {error&&<p role="alert" className="text-sm text-red-700">Could not run the test: {error}</p>}
    {report&&<div role="status" className="space-y-2 text-sm">
      <p className={report.verdict.sent?"font-semibold text-green-700":"font-semibold text-red-700"}>
        {report.verdict.sent?"Sent: Meta accepted the brief.":
          `Blocked at step "${report.verdict.step}": ${report.verdict.reason}`}</p>
      {report.verdict.details&&<pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs">
        {JSON.stringify(report.verdict.details,null,2)}</pre>}
      <ul className="list-disc pl-5">
        {report.settings.map(s=><li key={s.name}>{s.name}: {s.on?"on":"OFF"}</li>)}
        <li>Migration 20261104000148_morning_brief_send_window.sql: {report.migrationReady?"applied":"NOT applied"}</li>
      </ul>
    </div>}
  </section>;
}
