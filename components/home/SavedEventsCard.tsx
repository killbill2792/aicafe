"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {createTranslator} from "next-intl";
import {CalendarDays,ChevronLeft,ChevronRight,X} from "lucide-react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {CafeEvent,SavedEventTimeline} from "@/lib/data/cafeEvents.server";
import {EventReportCard} from "./EventReportCard";

type Locale="en"|"es"|"ar";
type T=(key:string,values?:Record<string,string|number>)=>string;
type Plan=SavedEventTimeline["plans"][number];
type Timeline=SavedEventTimeline&{today:string;currency?:string|null};
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


/** A read-only link from the saved venue address. No geocoding or guessed distance. */
export function eventVenueMapUrl(address:string|null):string|null{
  const value=address?.trim();
  if(!value||value.length>500||/[\u0000-\u001f\u007f]/u.test(value))return null;
  return "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(value);
}
export function VenueMapLink({address,t}:{address:string|null;t:T}){
  const url=eventVenueMapUrl(address);
  if(!url||!address)return null;
  return <a href={url} target="_blank" rel="noopener noreferrer"
    aria-label={t("mapLink")+": "+address.trim()}
    className="inline-flex min-h-12 max-w-full flex-wrap items-center gap-1 text-[17px] text-accent-text underline">
    <span dir="auto" className="break-words">{address.trim()}</span>
    <span className="whitespace-nowrap">· {t("mapLink")}</span>
  </a>;
}

export function eventStripDays(today:string){return Array.from({length:7},(_,i)=>dayAt(today,i));}
export function eventListDays(timeline:Timeline,tab:Tab,affectsOnly:boolean,sortByDate=false){
  const from=tab==="past"?dayAt(timeline.today,-14):tab==="now"?timeline.today:dayAt(timeline.today,1);
  const to=tab==="past"?dayAt(timeline.today,-1):tab==="now"?timeline.today:dayAt(timeline.today,14);
  const dates=new Set<string>();
  timeline.events.forEach(e=>{
    if(e.startDate<=to&&e.endDate>=from)dates.add(e.startDate<from?from:e.startDate);
  });
  timeline.plans.forEach(p=>{
    if(p.startDate<=to&&p.endDate>=from)dates.add(p.startDate<from?from:p.startDate);
  });
  const list=[...dates].filter(date=>!affectsOnly||Boolean(planOn(timeline.plans,date)));
  const importance=(day:string)=>{
    const level=planOn(timeline.plans,day)?.importance;
    return level==="high"?3:level==="medium"?2:level==="low"?1:0;
  };
  return list.sort((a,b)=>{
    if(tab==="past")return b.localeCompare(a);
    if(tab!=="upcoming"||sortByDate)return a.localeCompare(b);
    const nearEnd=dayAt(timeline.today,7);
    const aNear=a<=nearEnd,bNear=b<=nearEnd;
    if(aNear!==bNear)return aNear?-1:1;
    if(aNear&&bNear){
      const diff=importance(b)-importance(a);
      if(diff!==0)return diff;
    }
    return a.localeCompare(b);
  });
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
  onChatAboutDay:(date:string,title:string,existingThreadId?:string)=>void;
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
  const [sortByDate,setSortByDate]=useState(false);

  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const response=await fetch("/api/events/saved",{cache:"no-store",signal});
    if(!response.ok)throw new Error("events_unavailable");
    const data=await response.json() as Timeline;
    if(!Array.isArray(data.events)||!Array.isArray(data.plans)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.today))
      throw new Error("invalid_events");
    setTimeline(data);setError(false);
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void refresh(controller.signal).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[refresh]);
  if(!timeline)return <section data-testid="coming-up" aria-label={t("title")}
    className="space-y-2 rounded-2xl border border-line bg-card p-4 text-[17px] text-ink" role="status">
      <p>{error?t("loadFailed"):t("loading")}</p>
      {error&&<button type="button" onClick={()=>{setError(false);void refresh().catch(()=>setError(true));}}
        className="min-h-12 rounded-xl bg-accent px-4 font-semibold text-on-accent">{t("retry")}</button>}
    </section>;

  const today=timeline.today;
  const days=eventStripDays(today);
  const lead=days.map(date=>({date,plan:planOn(timeline.plans,date),
    events:eventsOn(timeline.events,date)}))
    .find(d=>Boolean(d.plan)||d.events.length>0);
  const openDay=(date:string)=>{setSelected(date);setPanel("day");setTab(date<today?"past":date===today?"now":"upcoming");setMonth(date.slice(0,7));};
  const openEvents=()=>{setPanel("events");setSelected(null);setTab("upcoming");setMonth(today.slice(0,7));};
  const chosen=selected??today;
  const plan=planOn(timeline.plans,chosen);
  const dayEvents=eventsOn(timeline.events,chosen);
  const actions=actionsFor(plan);
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
    onChatAboutDay(date,(matched[0]?.name??dayPlan?.summary??date).slice(0,120),
      dayPlan?.threadId);
    setPanel(null);
  };
  const listDates=eventListDays(timeline,tab,affectsOnly,sortByDate);
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
      {lead?<button type="button" disabled={disabled} onClick={()=>openDay(lead.date)}
        className="mb-3 w-full min-w-0 rounded-2xl bg-surface2 p-3 text-start disabled:opacity-60">
        <p className="text-[15px] font-semibold text-accent-text">{dateLabel(lead.date,locale,"long")} · {lead.date===today?t("now"):t("upcoming")}</p>
        <h3 className="mt-1 break-words font-headline text-[20px] font-bold leading-snug text-ink" dir="auto">
          {lead.events.map(e=>e.name).join(" · ")||t("savedInsight")}
        </h3>
        {lead.plan?.summary&&<p className="mt-2 line-clamp-3 text-[17px] leading-relaxed text-ink" dir="auto">{lead.plan.summary}</p>}
        {lead.date===today&&liveEventHeadline(lead.plan,today,t)&&<p className="mt-2 rounded-xl bg-card p-2 text-[17px]">{liveEventHeadline(lead.plan,today,t)}</p>}
        <span className="mt-2 inline-flex min-h-12 items-center font-semibold text-accent-text">{t("readInsights")} <ChevronRight size={19} className="ms-1 rtl:rotate-180" aria-hidden="true"/></span>
      </button>:<p className="mb-3 text-[17px] leading-snug text-ink-muted">{t("nothingSaved")}</p>}
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
        className="flex max-h-[94dvh] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-surface text-ink shadow-xl md:max-h-[90dvh] md:rounded-3xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-line p-3">
          {panel==="day"&&<button type="button" onClick={()=>setPanel("events")} aria-label={t("back")}
            className={button}><ChevronLeft size={20} className="rtl:rotate-180" aria-hidden="true"/></button>}
          <h3 className="min-w-0 flex-1 break-words font-headline text-[20px] font-bold">{panel==="day"?dateLabel(chosen,locale,"long"):t("title")}</h3>
          <button type="button" onClick={()=>setPanel(null)} aria-label={t("close")} className={button}>
            <X size={22} aria-hidden="true"/></button>
        </header>
        <div className="min-h-0 min-w-0 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain p-3 text-[17px] leading-relaxed sm:p-5">
          {panel==="events"?<>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label={t("title")}>
              {(["past","now","upcoming"] as const).map(key=><button key={key} type="button"
                aria-pressed={tab===key} onClick={()=>setTab(key)}
                className={"min-h-12 min-w-0 rounded-xl px-1 text-[16px] font-semibold sm:px-4 "+(tab===key?"bg-accent text-on-accent":"bg-surface2 text-ink")}>{t(key)}</button>)}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className={button+" bg-surface2"} onClick={()=>setCalendar(v=>!v)}
                aria-expanded={calendar}><CalendarDays size={19} className="me-2 inline" aria-hidden="true"/>{t("calendar")}</button>
              <button type="button" className={button+" bg-surface2"} aria-pressed={affectsOnly}
                onClick={()=>setAffectsOnly(v=>!v)}>{affectsOnly?t("affectsYou"):t("all")}</button>
              {tab==="upcoming"&&<button type="button" className={button+" bg-surface2"}
                aria-pressed={sortByDate} onClick={()=>setSortByDate(v=>!v)}>{sortByDate?t("dateFirst"):t("importanceFirst")}</button>}
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
            {!listDates.length&&<p className="rounded-xl bg-surface2 p-4 text-ink-muted">{t("noEvents")}</p>}
            {listDates.map(date=>{
              const saved=visibleEvents(date);
              const dayPlan=planOn(timeline.plans,date);
              return <section key={date} className="space-y-2 border-b border-line pb-3">
                <button type="button" onClick={()=>openDay(date)} className={button+" w-full bg-surface2 text-start"}>
                  {dateLabel(date,locale,"long")}{dayPlan?" · "+t("hasPlan"):""}
                </button>
                {saved.slice(0,3).map(event=><article key={event.id} className="rounded-xl border border-line p-3">
                  <p className="break-words font-headline text-[19px] font-semibold" dir="auto">{event.name}</p>
                  <p className="text-ink-muted" dir="auto">{event.startDate!==event.endDate?
                    event.startDate+" – "+event.endDate:event.startTime??""}
                    {event.venue||event.areaLabel?" · "+(event.venue??event.areaLabel):""}</p>
                  {event.status!=="found"&&<p role="status" className="font-semibold text-warn-text">{event.status==="cancelled"?t("cancelled"):t("moved")}</p>}
                  <p className="text-[15px] text-ink-muted">{event.verificationFailedAt&&(!event.lastVerifiedAt||event.verificationFailedAt>event.lastVerifiedAt)?t("verificationPending"):event.lastVerifiedAt?t("verifiedOn",{date:event.lastVerifiedAt.slice(0,10)}):t("lastSavedOn",{date:event.lastCheckedAt.slice(0,10)})}</p>
                  <VenueMapLink address={event.venueAddress} t={t}/>
                  {sourceUrl(event.sourceUrl)&&<a href={sourceUrl(event.sourceUrl)!} target="_blank" rel="noopener noreferrer"
                    className="inline-flex min-h-12 items-center text-accent-text underline">{t("source")}</a>}
                  <button type="button" onClick={()=>chat(date)}
                    className={button+" ms-3 text-accent-text underline"}>{t("chatAbout")}</button>
                </article>)}
                {saved.length>3&&<button type="button" className={button+" bg-surface2"}
                  onClick={()=>openDay(date)}>{t("moreEvents",{count:saved.length-3})}</button>}
                {dayPlan?.summary&&<p className="rounded-xl bg-surface2 p-3 text-[17px]" dir="auto">{dayPlan.summary}</p>}
                {tab==="past"&&dayPlan&&<EventReportCard report={dayPlan.report}
                  status={dayPlan.reportStatus} currency={timeline.currency??null}
                  locale={locale} t={t} onChat={()=>chat(date)}/>}
              </section>;
            })}
          </>:<>
            {dayEvents.map(event=><article key={event.id} className="space-y-2 rounded-2xl border border-line bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 flex-1 break-words font-headline text-[22px] font-bold leading-snug" dir="auto">{event.name}</h4>
                {event.status!=="found"&&<span role="status" className="rounded-lg bg-surface2 px-2 py-1 text-[15px] font-semibold text-warn-text">{event.status==="cancelled"?t("cancelled"):t("moved")}</span>}
              </div>
              <p className="text-ink-muted" dir="auto">{event.venue??event.areaLabel??t("venueUnknown")}{event.startTime?" · "+event.startTime:""}</p>
              <p className="text-[15px] text-ink-muted">{event.verificationFailedAt&&(!event.lastVerifiedAt||event.verificationFailedAt>event.lastVerifiedAt)?t("verificationPending"):event.lastVerifiedAt?t("verifiedOn",{date:event.lastVerifiedAt.slice(0,10)}):t("lastSavedOn",{date:event.lastCheckedAt.slice(0,10)})}</p>
              <VenueMapLink address={event.venueAddress} t={t}/>
              {sourceUrl(event.sourceUrl)&&<a className="inline-flex min-h-12 items-center text-accent-text underline"
                href={sourceUrl(event.sourceUrl)!} target="_blank" rel="noopener noreferrer">{t("source")}</a>}
            </article>)}
            {plan?<section className="space-y-4 rounded-2xl border border-line bg-card p-4" aria-label={t("savedInsight")}>
              <div>
                <p className="text-[15px] font-semibold text-accent-text">{t("savedInsight")}{plan.importance?" · "+t("importance"+plan.importance.charAt(0).toUpperCase()+plan.importance.slice(1)):""}</p>
                <p className="mt-2 break-words font-headline text-[20px] font-semibold leading-snug" dir="auto">{plan.summary}</p>
              </div>
              <PlanHours plan={plan} t={t}/>
              {actions.length>0&&<div className="space-y-2">
                <h4 className="font-bold">{t("recommendations")}</h4>
                <div className="grid gap-3 sm:grid-cols-2">{actions.map((action,index)=>
                  <article key={index} className="min-w-0 rounded-xl border border-line bg-surface2 p-3">
                    <h5 className="break-words font-semibold" dir="auto">{action.action}</h5>
                    <p className="mt-2 break-words text-ink-muted" dir="auto">{action.reason}</p>
                  </article>)}</div>
              </div>}
              {chosen===today&&liveEventHeadline(plan,chosen,t)&&<section aria-label={t("liveObservations")} className="rounded-xl bg-surface2 p-3">
                <h4 className="font-bold">{t("liveObservations")}</h4>
                <p role="status">{liveEventHeadline(plan,chosen,t)}</p>
              </section>}
              <EventReportCard report={plan.report} status={plan.reportStatus}
                currency={timeline.currency??null} locale={locale} t={t} onChat={()=>chat(chosen)}/>
            </section>:<p className="rounded-xl bg-surface2 p-4 text-ink-muted">{t("noPlan")}</p>}
            {dayEvents.length===0&&!plan&&<p className="text-ink-muted">{t("noEvents")}</p>}
            <button type="button" onClick={()=>chat(chosen)}
              className={button+" w-full bg-accent text-on-accent"}>{t("chatAbout")}</button>
          </>}
        </div>
      </section>
    </div>}
  </>;
}
