"use client";

import {useEffect,useMemo,useState} from "react";
import {createTranslator} from "next-intl";
import {CalendarDays,ChevronLeft,ChevronRight,X} from "lucide-react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {CafeEvent,EventChecklistTick,SavedEventTimeline} from "@/lib/data/cafeEvents.server";
import {eventActionAreaLabel} from "@/lib/events/eventActionArea";

type Locale="en"|"es"|"ar";
type T=(key:string,values?:Record<string,string|number>)=>string;
type Plan=SavedEventTimeline["plans"][number];
type Timeline=SavedEventTimeline&{today:string};
type Tab="past"|"now"|"upcoming";
type Panel="events"|"day"|null;
type Action={area:string;action:string;reason:string};
type SavedQuestion={question:string;options:string[]};
type Message={role:string;blocks:unknown[]|null};
/** The existing chat owns the question and how it is answered; the panel only
 * mirrors the latest unanswered question without creating another question. */
export function latestEventQuestion(messages:readonly Message[],locale:Locale):SavedQuestion|null{
  const latest=messages[messages.length-1];
  if(latest?.role!=="supervisor"||!Array.isArray(latest.blocks))return null;
  for(const raw of latest.blocks){
    if(!raw||typeof raw!=="object")continue;
    const block=raw as Record<string,unknown>;
    if(block.type==="clarify"&&typeof block.question==="string"){
      const options=Array.isArray(block.options)?block.options.flatMap(option=>{
        if(!option||typeof option!=="object")return [];
        const label=(option as {label?:unknown}).label;
        return typeof label==="string"?[label]:[];
      }):[];
      return {question:block.question,options};
    }
    if(block.type==="owner_question"){
      const title=block.title as Record<string,unknown>|null;
      if(!title||typeof title[locale]!=="string")continue;
      const input=block.input as {kind?:unknown;options?:unknown}|null;
      const options=Array.isArray(input?.options)?input.options.flatMap(option=>{
        const labels=option&&typeof option==="object"?(option as {label?:Record<string,unknown>}).label:null;
        return labels&&typeof labels[locale]==="string"?[labels[locale]]:[];
      }):[];
      return {question:title[locale] as string,options};
    }
  }
  return null;
}
const dayAt=(date:string,n:number)=>{
  const value=new Date(date+"T00:00:00Z");
  value.setUTCDate(value.getUTCDate()+n);
  return value.toISOString().slice(0,10);
};
const dateLabel=(date:string,locale:Locale,style:"short"|"long"="short")=>
  new Intl.DateTimeFormat(locale,{timeZone:"UTC",month:style==="short"?"short":"long",
    day:"numeric",weekday:style==="long"?"long":undefined}).format(new Date(date+"T00:00:00Z"));
const eventsOn=(events:readonly CafeEvent[],date:string)=>
  events.filter(e=>e.startDate<=date&&e.endDate>=date);
const planOn=(plans:readonly Plan[],date:string)=>
  plans.find(p=>p.startDate<=date&&p.endDate>=date);
const actionsFor=(plan:Plan|undefined):Action[]=>Array.isArray(plan?.actions)?
  plan.actions.filter((a):a is Action=>typeof a==="object"&&a!==null&&
    typeof a.action==="string"&&typeof a.reason==="string"&&typeof a.area==="string"):[];
const hoursFor=(plan:Plan|undefined):Array<{start:string;end:string}>=>
  Array.isArray(plan?.expectedBusyHours)?plan.expectedBusyHours.filter(
    (h):h is {start:string;end:string}=>typeof h==="object"&&h!==null&&
      typeof h.start==="string"&&typeof h.end==="string"):[];
const sourceUrl=(url:string|null)=>url&&/^https:\/\//i.test(url)?url:null;
/** Use the last canonical in-progress report; never infer live figures from a plan. */
export function liveEventHeadline(plan:Plan|undefined,date:string,t:T):string|null{
 if(plan?.reportStatus!=="in_progress"||!plan.report||typeof plan.report!=="object")return null;
 const raw=(plan.report as {liveWatch?:unknown}).liveWatch;
 if(!raw||typeof raw!=="object")return null;
 const live=raw as Record<string,unknown>;
 if(live.businessDate!==date||live.coverage!=="provisional"||
   typeof live.changePercent!=="number"||!Number.isFinite(live.changePercent)||
   typeof live.asOfLocal!=="string"||!/^([01]\d|2[0-3]):[0-5]\d$/.test(live.asOfLocal))
   return null;
 return t(live.changePercent>=0?"liveAhead":"liveBehind",{
   change:Math.abs(live.changePercent),time:live.asOfLocal,
   hourEnd:live.asOfLocal.slice(0,2)+":59",
 });
}


export function eventStripDays(today:string){return Array.from({length:7},(_,i)=>dayAt(today,i));}
export function eventListDays(timeline:Timeline,tab:Tab,affectsOnly:boolean){
  const from=tab==="past"?dayAt(timeline.today,-14):tab==="now"?timeline.today:dayAt(timeline.today,1);
  const to=tab==="past"?dayAt(timeline.today,-1):tab==="now"?timeline.today:dayAt(timeline.today,14);
  const dates=new Set<string>();
  timeline.events.forEach(e=>{
    if(e.startDate<=to&&e.endDate>=from)dates.add(e.startDate<from?from:e.startDate);
  });
  timeline.plans.forEach(p=>{
    if(p.startDate<=to&&p.endDate>=from)dates.add(p.startDate<from?from:p.startDate);
  });
  return [...dates].filter(date=>!affectsOnly||Boolean(planOn(timeline.plans,date)))
    .sort((a,b)=>tab==="past"?b.localeCompare(a):a.localeCompare(b));
}
function PlanHours({plan,t}:{plan:Plan;t:T}){
  const hours=hoursFor(plan);
  if(!hours.length)return null;
  const active=(hour:number)=>hours.some(h=>Number(h.start.slice(0,2))<=hour&&Number(h.end.slice(0,2))>hour);
  return <div className="space-y-2">
    <h4 className="text-[17px] font-semibold">{t("busyHours")}</h4>
    <div className="flex gap-1" role="img" aria-label={hours.map(h=>h.start+"–"+h.end).join(", ")}>
      {Array.from({length:24},(_,hour)=><div key={hour}
        className={"h-9 min-w-0 flex-1 rounded-sm "+(active(hour)?"bg-accent":"bg-surface2")}/>)}
    </div>
    <p className="text-[17px] text-ink-muted">{hours.map(h=>h.start+"–"+h.end).join(" · ")} · {t("estimated")}</p>
  </div>;
}

/** Opens over the same Supervisor conversation. Reads saved PR 3 facts and loop plans only. */
export default function SavedEventsCard({locale,disabled,onChatAboutDay}:{
  locale:Locale;disabled:boolean;
  onChatAboutDay:(date:string,title:string,prompt:string,existingThreadId?:string)=>void;
}){
  const t=useMemo(()=>createTranslator({locale,messages:{en,es,ar}[locale],namespace:"EventsPanel"}) as unknown as T,[locale]);
  const [timeline,setTimeline]=useState<Timeline|null>(null);
  const [error,setError]=useState(false);
  const [panel,setPanel]=useState<Panel>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [tab,setTab]=useState<Tab>("upcoming");
  const [affectsOnly,setAffectsOnly]=useState(false);
  const [calendar,setCalendar]=useState(false);
  const [month,setMonth]=useState<string|null>(null);
  const [tickData,setTickData]=useState<{proposalId:string;ticks:EventChecklistTick[]}|null>(null);
  const [questionData,setQuestionData]=useState<{proposalId:string;value:SavedQuestion|null}|null>(null);
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState(false);

  async function refresh(signal?:AbortSignal){
    const response=await fetch("/api/events/saved",{cache:"no-store",signal});
    if(!response.ok)throw new Error("events_unavailable");
    const data=await response.json() as Timeline;
    if(!Array.isArray(data.events)||!Array.isArray(data.plans)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.today))
      throw new Error("invalid_events");
    setTimeline(data);
  }
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/events/saved",{cache:"no-store",signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw new Error("events_unavailable");
        const data=await response.json() as Timeline;
        if(!Array.isArray(data.events)||!Array.isArray(data.plans)||
          !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.today))throw new Error("invalid_events");
        if(!controller.signal.aborted)setTimeline(data);
      }).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(!selected||!timeline)return;
    const plan=planOn(timeline.plans,selected);
    if(!plan)return;
    const controller=new AbortController();
    void fetch("/api/events/saved?proposalId="+encodeURIComponent(plan.proposalId),
      {cache:"no-store",signal:controller.signal})
      .then(r=>r.ok?r.json():Promise.reject(new Error("checklist_unavailable")))
      .then((data:{ticks:EventChecklistTick[]})=>setTickData({proposalId:plan.proposalId,ticks:data.ticks}))
      .catch(()=>{if(!controller.signal.aborted)setActionError(true);});
    return ()=>controller.abort();
  },[selected,timeline]);
  useEffect(()=>{
    if(panel!=="day"||!selected||!timeline)return;
    const plan=planOn(timeline.plans,selected);
    if(!plan)return;
    const controller=new AbortController();
    void fetch("/api/ai/threads/"+encodeURIComponent(plan.threadId)+"/messages?offset=0",
      {cache:"no-store",signal:controller.signal})
      .then(r=>r.ok?r.json():Promise.reject(new Error("messages_unavailable")))
      .then((page:{items:Message[]})=>{
        if(!controller.signal.aborted&&Array.isArray(page.items))
          setQuestionData({proposalId:plan.proposalId,value:latestEventQuestion(page.items,locale)});
      }).catch(()=>{});
    return ()=>controller.abort();
  },[panel,selected,timeline,locale]);
  if(!timeline)return error?null:<section data-testid="coming-up" aria-label={t("title")}
    className="rounded-2xl border border-line bg-card p-3 text-[17px] text-ink-muted" role="status">{t("loading")}</section>;

  const today=timeline.today;
  const days=eventStripDays(today);
  const lead=days.map(date=>({date,plan:planOn(timeline.plans,date),
    events:eventsOn(timeline.events,date)}))
    .find(d=>Boolean(d.plan)||d.events.length>0);
  const openDay=(date:string)=>{setSelected(date);setPanel("day");setActionError(false);setMonth(date.slice(0,7));};
  const openEvents=()=>{setPanel("events");setSelected(null);setTab("upcoming");setMonth(today.slice(0,7));};
  const chosen=selected??today;
  const plan=planOn(timeline.plans,chosen);
  const dayEvents=eventsOn(timeline.events,chosen);
  const actions=actionsFor(plan);
  const ticks=tickData&&tickData.proposalId===plan?.proposalId?tickData.ticks:[];
  const question=questionData&&questionData.proposalId===plan?.proposalId?questionData.value:null;
  const calendarMonth=month??today.slice(0,7);
  const calendarFirst=calendarMonth+"-01";
  const weekday=new Date(calendarFirst+"T00:00:00Z").getUTCDay();
  const monthLength=new Date(Number(calendarMonth.slice(0,4)),Number(calendarMonth.slice(5,7)),0).getDate();
  const calendarDays=Array.from({length:weekday+monthLength},(_,i)=>i<weekday?null:
    calendarMonth+"-"+String(i-weekday+1).padStart(2,"0"));
  const button="min-h-12 rounded-xl px-4 text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
  const chat=(date:string)=>{
    const matched=eventsOn(timeline.events,date);
    const dayPlan=planOn(timeline.plans,date);
    const context=JSON.stringify({date,events:matched.map(e=>({
      name:e.name,venue:e.venue,area:e.areaLabel,source:e.sourceUrl})),
      plan:dayPlan?{summary:dayPlan.summary,threadId:dayPlan.threadId}:null});
    onChatAboutDay(date,(matched[0]?.name??dayPlan?.summary??date).slice(0,120),
      t("chatPrompt",{date,context}),dayPlan?.threadId);
    setPanel(null);
  };
  const saveTick=async(index:number,state:"done"|"dismissed")=>{
    if(!plan||busy)return;
    setBusy(true);setActionError(false);
    try{
      const response=await fetch("/api/events/saved",{method:"POST",credentials:"same-origin",
        headers:{"content-type":"application/json"},body:JSON.stringify({
          proposalId:plan.proposalId,actionIndex:index,state,
        })});
      if(!response.ok)throw new Error("tick_unavailable");
      setTickData(previous=>({proposalId:plan.proposalId,ticks:[...(previous?.proposalId===plan.proposalId?previous.ticks:[])
        .filter(x=>x.actionIndex!==index),{actionIndex:index,state}]}));
    }catch{setActionError(true);}finally{setBusy(false);}
  };
  const approve=async()=>{
    if(!plan||busy)return;
    setBusy(true);setActionError(false);
    try{
      const response=await fetch("/api/ai/threads/"+encodeURIComponent(plan.threadId)+"/proposals",{
        method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"approve",proposalId:plan.proposalId,revision:plan.revision}),
      });
      if(!response.ok)throw new Error("approval_unavailable");
      await refresh();
    }catch{setActionError(true);}finally{setBusy(false);}
  };
  const approved=Boolean(plan&&["committed","monitored"].includes(plan.status));
  const listDates=eventListDays(timeline,tab,affectsOnly);
  const visibleEvents=(date:string)=>timeline.events.filter(e=>{
    const from=tab==="past"?dayAt(today,-14):tab==="now"?today:dayAt(today,1);
    return e.startDate<=date&&e.endDate>=date&&(e.startDate===date||(e.startDate<from&&date===from));
  });
  return <>
    <section data-testid="coming-up" aria-label={t("title")}
      className="min-w-0 rounded-2xl border border-line bg-card p-3">
      <button type="button" onClick={openEvents} disabled={disabled}
        className="flex min-h-12 w-full items-center gap-2 text-start font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <CalendarDays size={20} aria-hidden="true"/><span className="flex-1 text-[17px]">{t("title")}</span>
        <span className="text-[15px] text-accent-text">{t("seeAll")}</span>
      </button>
      <p className="mb-2 text-[17px] leading-snug text-ink" dir="auto">{lead?(lead.date===today?liveEventHeadline(lead.plan,today,t):null)||
          (lead.plan?.summary||lead.events.map(e=>e.name).join(" · ")):t("nothingSaved")}</p>
      <div className="grid grid-cols-7 gap-1">
        {days.map(date=>{
          const dayPlan=planOn(timeline.plans,date);
          const events=eventsOn(timeline.events,date);
          const name=dateLabel(date,locale);
          return <button key={date} type="button" disabled={disabled} onClick={()=>openDay(date)}
            aria-label={name+" · "+(dayPlan?.summary??events.map(e=>e.name).join(", ")??"")}
            className="flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-xl bg-surface2 px-0.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
            <span className="text-[13px]">{new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(new Date(date+"T00:00:00Z"))}</span>
            <span className="text-[17px] font-bold">{date.slice(8)}</span>
            <span aria-hidden="true" className={"h-2 w-2 rounded-full "+(dayPlan?"bg-accent":events.length?"bg-warn-text":"bg-line")}/>
          </button>;
        })}
      </div>
    </section>
    {panel&&<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center"
      role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setPanel(null);}}>
      <section role="dialog" aria-modal="true" aria-label={panel==="day"?dateLabel(chosen,locale,"long"):t("title")}
        dir={locale==="ar"?"rtl":"ltr"}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-surface text-ink shadow-xl md:rounded-3xl">
        <header className="flex items-center gap-2 border-b border-line p-3">
          {panel==="day"&&<button type="button" onClick={()=>setPanel("events")} aria-label={t("back")}
            className={button}><ChevronLeft size={20} className="rtl:rotate-180" aria-hidden="true"/></button>}
          <h3 className="flex-1 text-[19px] font-bold">{panel==="day"?dateLabel(chosen,locale,"long"):t("title")}</h3>
          <button type="button" onClick={()=>setPanel(null)} aria-label={t("close")} className={button}>
            <X size={22} aria-hidden="true"/></button>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 text-[17px]">
          {panel==="events"?<>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label={t("title")}>
              {(["past","now","upcoming"] as const).map(key=><button key={key} type="button"
                aria-pressed={tab===key} onClick={()=>setTab(key)}
                className={button+" "+(tab===key?"bg-accent text-on-accent":"bg-surface2")}>{t(key)}</button>)}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className={button+" bg-surface2"} onClick={()=>setCalendar(v=>!v)}
                aria-expanded={calendar}><CalendarDays size={19} className="me-2 inline" aria-hidden="true"/>{t("calendar")}</button>
              <button type="button" className={button+" bg-surface2"} aria-pressed={affectsOnly}
                onClick={()=>setAffectsOnly(v=>!v)}>{affectsOnly?t("affectsYou"):t("all")}</button>
            </div>
            {calendar&&<div className="rounded-2xl bg-surface2 p-2">
              <div className="flex items-center justify-between">
                <button type="button" className={button} aria-label={t("previousMonth")}
                  onClick={()=>setMonth(dayAt(calendarFirst,-1).slice(0,7))}><ChevronLeft aria-hidden="true"/></button>
                <span className="font-semibold">{new Intl.DateTimeFormat(locale,{year:"numeric",month:"long",timeZone:"UTC"})
                  .format(new Date(calendarFirst+"T00:00:00Z"))}</span>
                <button type="button" className={button} aria-label={t("nextMonth")}
                  onClick={()=>setMonth(dayAt(calendarMonth+"-"+String(monthLength).padStart(2,"0"),1).slice(0,7))}>
                    <ChevronRight aria-hidden="true"/></button>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {calendarDays.map((date,i)=>date?
                  <button key={date} type="button" disabled={date<dayAt(today,-14)||date>dayAt(today,14)}
                    onClick={()=>openDay(date)} className="min-h-12 rounded-lg bg-surface text-[17px] disabled:opacity-30"
                    aria-label={dateLabel(date,locale)}>{Number(date.slice(8))}</button>:
                  <span key={"blank-"+i}/>)}
              </div>
            </div>}
            {!listDates.length&&<p>{t("noEvents")}</p>}
            {listDates.map(date=>{
              const saved=visibleEvents(date);
              const dayPlan=planOn(timeline.plans,date);
              return <section key={date} className="space-y-2 border-b border-line pb-3">
                <button type="button" onClick={()=>openDay(date)} className={button+" w-full bg-surface2 text-start"}>
                  {dateLabel(date,locale,"long")}{dayPlan?" · "+t("hasPlan"):""}
                </button>
                {saved.slice(0,3).map(event=><article key={event.id} className="rounded-xl border border-line p-3">
                  <p className="font-semibold" dir="auto">{event.name}</p>
                  <p className="text-ink-muted" dir="auto">{event.startDate!==event.endDate?
                    event.startDate+" – "+event.endDate:event.startTime??""}
                    {event.venue||event.areaLabel?" · "+(event.venue??event.areaLabel):""}</p>
                  {event.status!=="found"&&<p>{event.status==="cancelled"?t("cancelled"):t("moved")}</p>}
                  {sourceUrl(event.sourceUrl)&&<a href={sourceUrl(event.sourceUrl)!} target="_blank" rel="noopener noreferrer"
                    className="inline-flex min-h-12 items-center text-accent-text underline">{t("source")}</a>}
                  <button type="button" onClick={()=>chat(date)}
                    className={button+" ms-3 text-accent-text underline"}>{t("chatAbout")}</button>
                </article>)}
                {saved.length>3&&<button type="button" className={button+" bg-surface2"}
                  onClick={()=>openDay(date)}>{t("moreEvents",{count:saved.length-3})}</button>}
              </section>;
            })}
          </>:<>
            {dayEvents.map(event=><article key={event.id} className="rounded-xl bg-surface2 p-3">
              <p className="font-semibold" dir="auto">{event.name}</p>
              <p className="text-ink-muted" dir="auto">{event.venue??event.areaLabel??""}{event.startTime?" · "+event.startTime:""}</p>
              {sourceUrl(event.sourceUrl)&&<a className="inline-flex min-h-12 items-center text-accent-text underline"
                href={sourceUrl(event.sourceUrl)!} target="_blank" rel="noopener noreferrer">{t("source")}</a>}
            </article>)}
            {plan?<>
              <p className="font-semibold" dir="auto">{plan.summary}</p>
              <PlanHours plan={plan} t={t}/>
              {question&&<section className="space-y-2 rounded-2xl border border-line bg-surface2 p-3">
                <h4 className="font-semibold" dir="auto">{question.question}</h4>
                <div className="flex flex-wrap gap-2">
                  {question.options.map(option=><button type="button" key={option}
                    onClick={()=>chat(chosen)} className={button+" bg-surface text-accent-text"}>{option}</button>)}
                  <button type="button" onClick={()=>chat(chosen)}
                    className={button+" bg-surface text-accent-text"}>{t("answerInChat")}</button>
                </div>
              </section>}
              <h4 className="text-[17px] font-bold">{t("getReady")}</h4>
              <ul className="space-y-2">{actions.map((action,index)=>{
                const done=ticks.find(x=>x.actionIndex===index)?.state==="done";
                return <li key={index} className="rounded-xl border border-line p-3">
                  <label className="flex min-h-12 items-center gap-3">
                    <input type="checkbox" className="h-6 w-6 accent-accent" checked={done}
                      disabled={!approved||busy} onChange={()=>void saveTick(index,done?"dismissed":"done")}/>
                    <span className="font-semibold" dir="auto">{action.action}</span>
                  </label>
                  <p className="mt-1 text-ink-muted" dir="auto">{action.reason}</p>
                  <p className="text-[15px] text-ink-muted">{eventActionAreaLabel(action.area,locale)}</p>
                </li>;
              })}</ul>
              {plan.status==="draft"&&<button type="button" disabled={busy}
                onClick={()=>void approve()} className={button+" w-full bg-accent text-on-accent"}>{t("usePlan")}</button>}
              {!approved&&plan.status!=="draft"&&<p>{t("planNotActive")}</p>}
              {plan.status==="draft"&&<p className="text-ink-muted">{t("approveFirst")}</p>}
              {plan.reportStatus&&<p className="rounded-xl bg-surface2 p-3">{t("reportAvailable")}</p>}
            </>:<p className="text-ink-muted">{t("noPlan")}</p>}
            {actionError&&<p role="alert">{t("saveFailed")}</p>}
            <button type="button" onClick={()=>chat(chosen)}
              className={button+" w-full bg-surface2 text-accent-text"}>{t("chatAbout")}</button>
            {plan&&<p className="text-ink-muted">{t("questionInChat")}</p>}
          </>}
        </div>
      </section>
    </div>}
  </>;
}
