"use client";

import {useEffect,useRef,useState,type ReactNode} from "react";
import {BookOpen,Clock3,ListChecks,RefreshCcw,ShieldCheck,X,Search,Paperclip} from "lucide-react";
import {Link} from "@/i18n/navigation";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";
import en from "@/messages/en.json";

import SupervisorWorkStatus from "./SupervisorWorkStatus";
import {useSupervisorWork} from "./useSupervisorWork";
import type {StoredAttachment} from "@/lib/ai/conversations/attachments";
import type {OwnerWorkItem} from "@/lib/ai/supervisor/runs/ownerWorkView";

const copy=en.SupervisorMandateCenter;
type Tab="work"|"library"|"routines"|"permissions";
type Thread={id:string;title:string|null;lastMessageAt?:string|null;createdAt:string};
type Routine={id:string;threadId:string;title:string;cadence:"daily"|"weekly";localTime:string;
  status:"active"|"paused"|"revoked";weekdays:number[];timezone:string;revision:number};
type Mandate={id:string;revision:number;capability_id:string;capability_version:number;
  limit_kind:"count";limit_value:number;period_kind:string;staff_week_start:string|null;
  expires_at:string;revoked_at:string|null;superseded_at:string|null;verified_at:string};
type Challenge={challengeId:string;expiresAt:string;capabilityId:string;limitValue:number};
type ActionResponse={challenge?:Challenge;mandate?:Mandate};

const capabilityName=(id:string)=>id==="leo.goal.v1"?copy.goalName:
  id==="olivia.staff_propose_send_schedule.v2"?copy.staffName:copy.unknownName;
const mandateStatus=(m:Mandate,now:number)=>m.revoked_at?"revoked":
  m.superseded_at?"superseded":Date.parse(m.expires_at)<=now?"expired":"active";
const statusLabel=(status:string)=>status==="active"?copy.active:
  status==="expired"?copy.expired:status==="revoked"?copy.revoked:copy.superseded;
const humanTime=(date:string)=>new Date(date).toLocaleString();
const validLocalExpiry=(value:string,clock:number)=>Boolean(value.trim())&&
  Number.isFinite(new Date(value).valueOf())&&new Date(value).valueOf()>clock;

export default function SupervisorMandatePanel({threadId,threads,approvals,onSelectThread,onClose,initialTab="permissions",onOpenWork,disabled=false,languageSwitch,files,reports=[],onOpenReport,threadsNextOffset=null}:{
  threadId:string|null;threads:Thread[];approvals:Array<{id:string;title:string;detail:string}>;
  onSelectThread:(id:string,thread?:Thread)=>void;onClose:()=>void;
  files?:{threadId:string;items:StoredAttachment[]}|null;threadsNextOffset?:number|null;
  reports?:{id:string;createdAt:string;title:string|null}[];onOpenReport?:(id:string)=>void;
  initialTab?:Tab;onOpenWork:(item:OwnerWorkItem)=>void;disabled?:boolean;languageSwitch?:ReactNode;
}){
  const [tab,setTab]=useState<Tab>(initialTab);
  const [search,setSearch]=useState("");
  const [olderThreads,setOlderThreads]=useState<Thread[]>([]);
  const [historyCursor,setHistoryCursor]=useState<number|null|undefined>(undefined);
  const historyOffset=historyCursor===undefined?threadsNextOffset:historyCursor;
  const [historyBusy,setHistoryBusy]=useState(false);
  const [historyError,setHistoryError]=useState("");
  const historyRequest=useRef<AbortController|null>(null);
  const [mandates,setMandates]=useState<Mandate[]>([]);
  const [routines,setRoutines]=useState<Routine[]>([]);
  const [loading,setLoading]=useState(Boolean(threadId??threads[0]?.id));
  const [routinesLoading,setRoutinesLoading]=useState(false);
  const [error,setError]=useState("");
  const [routineError,setRoutineError]=useState("");
  const [notice,setNotice]=useState("");
  const [factor,setFactor]=useState<string|null>(null);
  const [factorError,setFactorError]=useState(false);
  const [expiry,setExpiry]=useState("");
  const [code,setCode]=useState("");
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [busy,setBusy]=useState(false);
  const [now,setNow]=useState(0);
  const [refresh,setRefresh]=useState(0);
  const closeButton=useRef<HTMLButtonElement|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const mandateThreadId=threadId??threads[0]?.id??null;
  const work=useSupervisorWork(mandateThreadId,tab==="work",true);

  useEffect(()=>{
    const node=dialog.current;
    if(!node)return;
    const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
    node.showModal();
    closeButton.current?.focus();
    return()=>{historyRequest.current?.abort();if(node.open)node.close();opener?.focus();};
  },[]);
  useEffect(()=>{
    const initial=window.setTimeout(()=>setNow(Date.now()),0);
    const tick=window.setInterval(()=>setNow(Date.now()),10_000);
    return()=>{window.clearTimeout(initial);window.clearInterval(tick);};
  },[]);

  useEffect(()=>{
    if(tab!=="permissions"||!mandateThreadId)return;
    let live=true;
    async function load(){
      try{
        const [response,sessionFactors]=await Promise.all([
          fetch("/api/ai/threads/"+encodeURIComponent(mandateThreadId!)+"/mandates",
            {credentials:"same-origin",cache:"no-store"}),
          createBrowserSupabaseClient().auth.mfa.listFactors(),
        ]);
        if(!response.ok)throw new Error(response.status===401||response.status===403?
          copy.ownerRequired:copy.permissionUnavailable);
        const payload=await response.json() as {mandates?:Mandate[]};
        if(!live)return;
        if(!Array.isArray(payload.mandates))throw new Error(copy.permissionUnavailable);
        setNow(Date.now());
        setMandates(payload.mandates);
        const found=sessionFactors.error?null:
          sessionFactors.data?.phone?.find(item=>item.status==="verified")??null;
        setFactor(found?.id??null);
        setFactorError(Boolean(sessionFactors.error));
      }catch(e){if(live){setError(e instanceof Error?e.message:copy.permissionUnavailable);
        setFactor(null);setFactorError(true);}}
      finally{if(live)setLoading(false);}
    }
    void load();
    return()=>{live=false;};
  },[tab,mandateThreadId,refresh]);

  useEffect(()=>{
    if(tab!=="routines")return;
    let live=true;
    void fetch("/api/ai/supervisor/routines",{credentials:"same-origin",cache:"no-store"})
      .then(async response=>{
        if(!response.ok)throw new Error(copy.routineUnavailable);
        const data=await response.json() as {routines?:Routine[]};
        if(!Array.isArray(data.routines))throw new Error(copy.routineUnavailable);
        if(live)setRoutines(data.routines);
      }).catch(()=>{if(live)setRoutineError(copy.routineUnavailable);})
      .finally(()=>{if(live)setRoutinesLoading(false);});
    return()=>{live=false;};
  },[tab,refresh]);

  async function post(body:Record<string,unknown>):Promise<ActionResponse>{
    if(!mandateThreadId)throw new Error(copy.noThread);
    const response=await fetch("/api/ai/threads/"+encodeURIComponent(mandateThreadId)+"/mandates",{
      method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
      cache:"no-store",body:JSON.stringify(body),
    });
    if(!response.ok)throw new Error(response.status===401||response.status===403?
      copy.ownerRequired:response.status===409?copy.revisionConflict:copy.generalError);
    return response.json() as Promise<ActionResponse>;
  }
  async function startChallenge(existing?:Mandate){
    if(busy)return;
    setError("");setNotice("");setChallenge(null);setCode("");
    if(!factor){setError(copy.phoneRequired);return;}
    if(!validLocalExpiry(expiry,Date.now())){setError(copy.chooseExpiry);return;}
    setBusy(true);
    try{
      const result=await post({
        action:"challenge",factorId:factor,limitValue:5,
        expiresAt:new Date(expiry).toISOString(),
        ...(existing?{mandateId:existing.id,revision:existing.revision}:{}),
      });
      if(!result.challenge||result.challenge.capabilityId!=="leo.goal.v1"||
        result.challenge.limitValue!==5||Date.parse(result.challenge.expiresAt)<=Date.now())
        throw new Error(copy.requestFailed);
      setChallenge(result.challenge);setNotice(copy.challengeIssued);
    }catch(e){setError(e instanceof Error&&e.message===copy.ownerRequired?copy.ownerRequired:copy.requestFailed);}
    finally{setBusy(false);}
  }
  async function verify(){
    if(!challenge||!code.trim()||busy)return;
    if(Date.parse(challenge.expiresAt)<=Date.now()){
      setChallenge(null);setCode("");setError(copy.challengeExpired);return;
    }
    setBusy(true);setError("");
    try{
      const result=await post({action:"verify",challengeId:challenge.challengeId,code:code.trim()});
      if(!result.mandate||result.mandate.capability_id!=="leo.goal.v1"||
        result.mandate.limit_value!==5||result.mandate.revoked_at||
        Date.parse(result.mandate.expires_at)<=Date.now())
        throw new Error(copy.verifyFailed);
      setChallenge(null);setMandates(existing=>[
        result.mandate!,...existing.filter(m=>m.id!==result.mandate!.id),
      ]);
      setNotice(copy.grantConfirmed);
      setLoading(true);setRefresh(n=>n+1);
    }catch(e){setError(e instanceof Error&&e.message===copy.ownerRequired?copy.ownerRequired:copy.verifyFailed);}
    finally{setCode("");setBusy(false);}
  }
  async function revoke(m:Mandate){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await post({action:"revoke",mandateId:m.id,revision:m.revision});
      if(!result.mandate||result.mandate.id!==m.id||
        result.mandate.revision<=m.revision||!result.mandate.revoked_at)
        throw new Error(copy.revokeFailed);
      setMandates(rows=>rows.map(row=>row.id===m.id?result.mandate!:row));
      setChallenge(null);setCode("");setNotice(copy.revokeConfirmed);
      setLoading(true);setRefresh(n=>n+1);
    }catch(e){setError(copy.revokeFailed+(e instanceof Error&&e.message===copy.revisionConflict?" "+copy.revisionConflict:""));}
    finally{setBusy(false);}
  }
  const goal=mandates.find(m=>m.capability_id==="leo.goal.v1"&&
    mandateStatus(m,now)==="active");
  const expiredChallenge=Boolean(challenge&&Date.parse(challenge.expiresAt)<=now);
  const allThreads=[...new Map([...olderThreads,...threads].map(t=>[t.id,t])).values()].sort((a,b)=>(b.lastMessageAt??b.createdAt).localeCompare(a.lastMessageAt??a.createdAt));
  const term=search.trim().toLocaleLowerCase();
  const matches=(value:string)=>value.toLocaleLowerCase().includes(term);
  const filteredThreads=allThreads.filter(t=>matches(t.title??copy.savedChats));
  const filteredReports=reports.filter(report=>matches(report.title??en.SupervisorExperience.savedReport));
  const filteredFiles=files&&files.threadId===threadId?files.items.filter(file=>matches(file.originalName)):[];
  const noMatches=Boolean(term)&&!filteredThreads.length&&!filteredReports.length&&!filteredFiles.length;
  async function loadHistory(){
    if(historyBusy||historyOffset===null||historyRequest.current)return;
    const request=new AbortController();historyRequest.current=request;setHistoryBusy(true);setHistoryError("");
    try{
      const response=await fetch("/api/ai/threads?offset="+historyOffset,{credentials:"same-origin",cache:"no-store",signal:request.signal});
      if(!response.ok)throw Error("history_failed");
      const result=await response.json() as {items:Thread[];nextOffset:number|null};
      if(!Array.isArray(result.items)||!(result.nextOffset===null||Number.isSafeInteger(result.nextOffset)&&result.nextOffset>historyOffset))throw Error("history_invalid");
      if(!request.signal.aborted){setOlderThreads(items=>[...items,...result.items]);setHistoryCursor(result.nextOffset);}
    }catch{if(!request.signal.aborted)setHistoryError(en.SupervisorExperience.historyUnavailable);}
    finally{if(!request.signal.aborted){historyRequest.current=null;setHistoryBusy(false);}}
  }

  return <dialog ref={dialog} aria-modal="true" aria-label={copy.title}
    onCancel={e=>{e.preventDefault();onClose();}}
    onKeyDown={e=>{
      if(e.key!=="Tab")return;
      const elements=Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]'
      )).filter(node=>node.tabIndex>=0&&node.getClientRects().length&&!node.closest("[inert],[aria-hidden=true]")&&getComputedStyle(node).visibility!=="hidden");
      const first=elements[0],last=elements.at(-1);
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }}
    className="supervisor-drawer fixed inset-y-0 start-0 end-auto m-0 h-full max-h-none w-full max-w-[440px] flex-col border-e border-line bg-surface text-ink backdrop:bg-fg/30 open:flex">
      <header className="flex items-center justify-between px-4 py-3">
        <h2 className="font-headline text-[19px] font-medium tracking-tight text-ink">{copy.title}</h2>
        <button ref={closeButton} type="button" onClick={onClose} aria-label={copy.close}
          className="flex h-12 w-12 items-center justify-center rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          <X size={22} aria-hidden="true"/>
        </button>
      </header>
      <nav aria-label={copy.title} className="grid grid-cols-2 gap-1 border-b border-line px-3 pb-2 sm:grid-cols-4">
        {([["work",ListChecks,en.SupervisorWork.heading],["library",BookOpen,copy.library],["routines",Clock3,copy.routines],
          ["permissions",ShieldCheck,copy.permissions]] as const).map(([id,Icon,label])=>
          <button key={id} type="button" onClick={()=>{
              // An active-tab click does not change the fetch dependencies.
              // Keep its settled data and avoid an orphaned loading flag.
              if(id===tab)return;
              if(id==="permissions"){setLoading(Boolean(mandateThreadId));setError("");}
              if(id==="routines"){setRoutinesLoading(true);setRoutineError("");}
              setTab(id);
            }}
            aria-current={tab===id?"page":undefined}
            className={"flex min-h-12 items-center justify-center gap-1.5 rounded-full px-2 text-[14px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink "+
              (tab===id?"bg-surface2 text-ink":"text-ink-muted hover:bg-surface2")}>
            <Icon size={17} aria-hidden="true"/><span>{label}</span>
          </button>)}
      </nav>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-supervisor-controls={tab}>
        {tab==="work"&&(mandateThreadId?<SupervisorWorkStatus items={work.items} unavailable={work.unavailable}
          loading={work.loading} showEmpty onOpen={onOpenWork} disabled={disabled}/>:<p role="status">{copy.emptyChats}</p>)}
        {tab==="library"&&<section aria-label={copy.savedChats} className="space-y-2">
          <h3 className="text-[15px] font-medium text-ink-muted">{copy.savedChats}</h3>
          <label className="flex min-h-12 items-center gap-2 rounded-lg border border-line px-3"><Search size={18} aria-hidden="true"/><span className="sr-only">{en.SupervisorExperience.searchLoadedChats}</span><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder={en.SupervisorExperience.searchLoadedChats} className="min-w-0 flex-1 bg-transparent text-[17px] text-ink"/></label>
          {allThreads.length===0&&<p className="text-sm text-ink-muted">{copy.emptyChats}</p>}
          {noMatches&&<p role="status" className="text-sm text-ink-muted">{en.SupervisorExperience.noMatchingChats}</p>}
          {filteredThreads.map(thread=><button key={thread.id} type="button" data-library-thread={thread.id}
            disabled={disabled} onClick={()=>{onSelectThread(thread.id,thread);onClose();}}
            aria-current={thread.id===threadId?"page":undefined}
            className="block min-h-12 w-full rounded-lg px-3 py-2 text-start text-[17px] font-normal leading-snug text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            {thread.title||copy.savedChats}
          </button>)}
          {historyError&&<p role="alert" className="text-sm text-ink-muted">{historyError}</p>}
          {historyOffset!==null&&<button type="button" disabled={historyBusy} onClick={()=>void loadHistory()} className="min-h-12 rounded-lg border border-line px-3 text-[15px] text-ink">{historyBusy?copy.loading:en.SupervisorExperience.loadOlderChats}</button>}
          {filteredReports.length>0&&onOpenReport&&<section aria-label={en.SupervisorExperience.loadedReports} className="border-t border-line pt-3">
            <h3 className="text-[15px] font-medium text-ink-muted">{en.SupervisorExperience.loadedReports}</h3>
            {filteredReports.map(report=><button key={report.id} type="button" disabled={disabled} data-library-report={report.id} onClick={()=>{onOpenReport(report.id);onClose();}} className="flex min-h-12 w-full items-center gap-2 rounded-lg px-2 text-start hover:bg-surface2 disabled:opacity-50"><BookOpen size={18} className="shrink-0" aria-hidden="true"/><span className="min-w-0 break-words text-[17px]">{report.title??en.SupervisorExperience.savedReport}<span className="block text-[13px] text-ink-muted">{humanTime(report.createdAt)}</span></span></button>)}
          </section>}
          {files&&files.threadId===threadId&&filteredFiles.length>0&&<section aria-label={en.SupervisorExperience.conversationFiles} className="border-t border-line pt-3">
            <h3 className="text-[15px] font-medium text-ink-muted">{en.SupervisorExperience.conversationFiles}</h3>
            {filteredFiles.map(file=><a key={file.id} href={"/api/ai/threads/"+encodeURIComponent(files.threadId)+"/attachments/"+encodeURIComponent(file.id)} target="_blank" rel="noopener noreferrer" className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg px-2 text-[17px] text-ink underline hover:bg-surface2"><Paperclip size={18} className="shrink-0" aria-hidden="true"/><span className="min-w-0 break-all">{file.originalName}</span></a>)}
          </section>}
        </section>}
        {tab==="routines"&&<section aria-label={copy.routineTitle} className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-ink">{copy.routineTitle}</h3>
            <button type="button" aria-label={copy.refresh} onClick={()=>{setRoutinesLoading(true);setRoutineError("");setRefresh(n=>n+1);}}
              className="flex h-12 w-12 items-center justify-center rounded-lg border border-line">
              <RefreshCcw size={17} aria-hidden="true"/>
            </button>
          </div>
          <p className="text-sm text-ink-muted">{copy.routineHelp}</p>
          {routinesLoading&&<p role="status" className="text-sm">{copy.loading}</p>}
          {routineError&&<p role="alert" className="text-sm text-neg">{routineError}</p>}
          {!routinesLoading&&!routineError&&routines.length===0&&<p>{copy.emptyRoutines}</p>}
          {!routinesLoading&&!routineError&&routines.map(r=>
            <article key={r.id} className="space-y-1 rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[15px]">{r.title}</strong>
                <span className="text-xs text-ink-muted">{r.status}</span>
              </div>
              <p className="text-[15px] text-ink-muted">{r.cadence} · {r.localTime} · {r.timezone}</p>
              {r.cadence==="weekly"&&<p className="text-[15px] text-ink-muted">{r.weekdays.map(day=>en.SupervisorExperience.weekdayNames[day-1]).filter(Boolean).join(", ")}</p>}
              {r.threadId&&<button type="button" disabled={disabled} className="min-h-12 rounded-lg px-2 text-[15px] font-medium text-accent-text underline disabled:opacity-50" onClick={()=>{onSelectThread(r.threadId);onClose();}}>{en.SupervisorExperience.openRoutineChat}</button>}
            </article>)}
        </section>}
        {tab==="permissions"&&<section aria-label={copy.permissionTitle} className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-ink">{copy.permissionTitle}</h3>
            <button type="button" aria-label={copy.refresh} onClick={()=>{setLoading(Boolean(mandateThreadId));setError("");setRefresh(n=>n+1);}}
              disabled={busy}
              className="flex h-12 w-12 items-center justify-center rounded-lg border border-line disabled:opacity-50">
              <RefreshCcw size={17} aria-hidden="true"/>
            </button>
          </div>
          <p className="text-sm text-ink-muted">{copy.permissionHelp}</p>
          <section aria-label={copy.oneTimeTitle} className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <h4 className="text-sm font-semibold">{copy.oneTimeTitle}</h4>
            <p className="text-sm text-ink-muted">{copy.oneTimeHelp}</p>
            {approvals.length===0?<p className="text-sm text-ink-muted">{copy.oneTimeEmpty}</p>:
              approvals.map(a=><p key={a.id} className="text-sm">
                <strong>{a.title}</strong> — {a.detail}
              </p>)}
          </section>
          {!mandateThreadId&&<p role="status">{copy.noThread}</p>}
          {loading&&<p role="status" className="text-sm">{copy.loading}</p>}
          {error&&<p role="alert" className="rounded-lg bg-neg-soft p-3 text-sm text-neg">{error}</p>}
          {notice&&<p role="status" className="rounded-lg bg-pos-soft p-3 text-sm text-ink">{notice}</p>}
          {!loading&&!error&&mandateThreadId&&mandates.length===0&&
            <p className="text-sm text-ink-muted">{copy.emptyPermissions}</p>}
          {!loading&&!error&&mandates.map(m=>{
            const status=mandateStatus(m,now);
            return <article key={m.id+":"+m.revision}
              className="space-y-2 rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[15px]">{capabilityName(m.capability_id)}</strong>
                <span className="text-xs font-semibold text-ink-muted">{statusLabel(status)}</span>
              </div>
              <p className="text-sm text-ink-muted">
                {copy.limit}: {m.limit_value} {m.period_kind==="cafe_day"?copy.goalDaily:copy.staffRecipients}
              </p>
              {m.staff_week_start&&<p className="text-sm text-ink-muted">{copy.week}: {m.staff_week_start}</p>}
              <p className="text-sm text-ink-muted">{copy.expires}: {humanTime(m.expires_at)}</p>
              {status==="active"&&<div className="flex flex-wrap gap-2">
                {m.capability_id==="leo.goal.v1"&&<button type="button"
                  onClick={()=>{setChallenge(null);setCode("");setNotice(copy.chooseExpiry);}}
                  className="min-h-12 rounded-xl border border-line px-3 text-sm font-semibold">
                  {copy.reviseGoal}
                </button>}
                <button type="button" disabled={busy} onClick={()=>void revoke(m)}
                  className="min-h-12 rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-40">
                  {copy.revoke}
                </button>
              </div>}
            </article>;
          })}
          {mandateThreadId&&!loading&&!error&&<div className="space-y-3 rounded-xl border border-line bg-surface p-3">
            <h4 className="font-semibold">{goal?copy.reviseGoal:copy.newGoal}</h4>
            <p className="text-sm text-ink-muted">5 {copy.goalDaily}</p>
            {factorError&&<p className="text-sm text-neg">{copy.factorUnavailable}</p>}
            {!factor&&<p className="text-sm text-ink-muted">{copy.phoneRequired}</p>}
            {factor&&<label className="block space-y-1 text-sm font-medium">
              <span>{copy.chooseExpiry}</span>
              <input type="datetime-local" value={expiry}
                onChange={e=>setExpiry(e.target.value)}
                className="min-h-12 w-full rounded-xl border border-line bg-surface2 p-3 text-base"/>
            </label>}
            {factor&&!challenge&&<button type="button" disabled={busy||!validLocalExpiry(expiry,now)}
              onClick={()=>void startChallenge(goal)}
              className="min-h-12 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40">
              {copy.requestCode}
            </button>}
            {factor&&challenge&&<div className="space-y-2">
              <p className="text-sm text-ink-muted">{copy.challengeExpires}: {humanTime(challenge.expiresAt)}</p>
              {expiredChallenge?<p role="alert" className="text-sm text-neg">{copy.challengeExpired}</p>:
                <label className="block space-y-1 text-sm font-medium">
                  <span>{copy.code}</span>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code"
                    value={code} maxLength={32} onChange={e=>setCode(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-line bg-surface2 p-3 text-base"/>
                </label>}
              {!expiredChallenge&&<button type="button" disabled={busy||!code.trim()}
                onClick={()=>void verify()}
                className="min-h-12 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40">
                {copy.verify}
              </button>}
              <button type="button" disabled={busy} onClick={()=>{setChallenge(null);setCode("");}}
                className="min-h-12 rounded-xl border border-line px-4 text-sm font-semibold disabled:opacity-40">
                {copy.requestCode}
              </button>
            </div>}
          </div>}
          <p className="text-sm text-ink-muted">{copy.staffHelp}</p>
          <Link href="/staff" className="inline-flex min-h-12 items-center rounded-xl border border-line px-4 text-sm font-semibold text-ink">
            {copy.staffGrant}
          </Link>
          <p className="text-sm text-ink-muted">{copy.notUnlimited}</p>
        </section>}
      </div>
      <div className="shrink-0 border-t border-line px-3">
        <Link href={threadId?"/more/supervisor-access?thread="+encodeURIComponent(threadId):"/more/supervisor-access"}
          className="flex min-h-12 items-center gap-2 rounded-lg px-2 text-[15px] font-medium text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"><ShieldCheck size={18} aria-hidden="true"/>{en.SupervisorAccess.title}</Link>
      </div>
      {languageSwitch}
  </dialog>;
}
