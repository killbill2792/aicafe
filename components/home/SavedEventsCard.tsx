"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {createTranslator} from "next-intl";
import {CalendarDays,ChevronLeft,ChevronRight,Lightbulb,X} from "lucide-react";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {CafeEvent,SavedEventTimeline,CityCatalogPage,CityCoverageOverview} from "@/lib/data/cafeEvents.server";
import {EventReportCard} from "./EventReportCard";

type Locale="en"|"es"|"ar";
type T=(key:string,values?:Record<string,string|number>)=>string;
type Plan=SavedEventTimeline["plans"][number];
type Timeline=SavedEventTimeline&{today:string;currency?:string|null};
type Tab="past"|"now"|"upcoming";
type Panel="events"|"day"|null;
type View="cafe"|"city";
type Action={area:string;action:string;reason:string};

/** Suggestions are read-only advice, never actionable checkboxes. */
export function EventAdviceItem({action}:{action:Action}){
  return <li className="flex min-w-0 items-start gap-3 rounded-xl border border-line bg-surface2 p-3">
    <Lightbulb aria-hidden="true" size={22} className="mt-0.5 shrink-0 text-accent-text"/>
    <div className="min-w-0">
      <h5 className="break-words font-semibold" dir="auto">{action.action}</h5>
      <p className="mt-1 break-words text-ink-muted" dir="auto">{action.reason}</p>
    </div>
  </li>;
}
type SavedQuestion={question:string;options:string[]};
type Message={role:string;blocks:unknown[]|null};

/** One navigation control shared by Home, the Events index and event details. */
export function EventsTabs({tab,onChoose,t}:{tab:Tab;onChoose:(next:Tab)=>void;t:T}){
  return <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("title")}>
    {(["past","now","upcoming"] as const).map(key=><button key={key} type="button"
      aria-pressed={tab===key} onClick={()=>onChoose(key)}
      className={"min-h-12 min-w-0 rounded-xl px-2 text-[16px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink "+
        (tab===key?"bg-accent text-on-accent":"bg-surface2 text-ink")}>{t(key)}</button>)}
  </div>;
}
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
    day:"numeric",year:style==="long"?"numeric":undefined,
    weekday:style==="long"?"long":undefined}).format(new Date(date+"T00:00:00Z"));
const eventsOn=(events:readonly CafeEvent[],date:string)=>
  events.filter(e=>e.startDate<=date&&e.endDate>=date);
/** Never substitute another event from the same date for the owner's exact tap. */
export function selectedSavedEvent(events:readonly CafeEvent[],date:string,eventId:string|null){
  return eventId?eventsOn(events,date).find(e=>e.id===eventId)??null:null;
}
/** A multi-day event opens the date the owner tapped, not its historic start day. */
export function eventDetailDay(event:Pick<CafeEvent,"startDate"|"endDate">,viewDate:string){
  return viewDate>=event.startDate&&viewDate<=event.endDate?viewDate:event.startDate;
}
/** Preserve the exact tapped event across Home, chat and saved day reports. */
export function eventChatTarget(date:string,event?:Pick<CafeEvent,"id"|"name">,
  plan?:Pick<Plan,"summary"|"threadId">){
  return {date,title:event?.name??plan?.summary??date,eventId:event?.id,
    existingThreadId:event?undefined:plan?.threadId};
}
const planOn=(plans:readonly Plan[],date:string)=>
  plans.find(p=>p.startDate<=date&&p.endDate>=date);
/** A discovery is NOT a café alert: only Supervisor-selected IDs are highlighted.
 * Legacy day-only plans remain readable without attributing them to an event. */
export function cafeHighlightedEvents(timeline:Pick<Timeline,"events"|"plans">,date:string):CafeEvent[]{
  const ids=new Set(timeline.plans.filter(p=>p.startDate<=date&&p.endDate>=date)
    .flatMap(p=>p.eventIds??[]));
  return timeline.events.filter(e=>ids.has(e.id)&&e.startDate<=date&&e.endDate>=date);
}
export function cityEventChatTarget(item:CityCatalogPage["items"][number]){
  return {date:item.startDate,title:item.name,eventId:item.cafeEventId??undefined,
    cityEventId:item.cafeEventId?undefined:item.id};
}
const cityKindLabel=(kind:string,t:T)=>{
  const known=["festival","conference","sports","parade","community","other"];
  return t(known.includes(kind)?"kind"+kind.charAt(0).toUpperCase()+kind.slice(1):"kindOther");
};
const nextMonth=(month:string,delta:number)=>{
  const d=new Date(month+"-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth()+delta);
  return d.toISOString().slice(0,7);
};
const cityMonthEnd=(month:string)=>dayAt(nextMonth(month,1)+"-01",-1);
/** A dated event can have multiple proposals. Never show another event's or day's
 * AI analysis; prefer the owner-approved choice over a draft on the same date. */
export function eventPlanFor(plans:readonly Plan[],eventId:string,date:string):Plan|undefined{
  const matching=plans.filter(p=>p.eventIds?.includes(eventId)&&
    p.startDate<=date&&p.endDate>=date);
  return matching.find(p=>["approved","committed","manual_confirmed"].includes(p.status))??matching[0];
}
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

/** An individual event opens its own saved read-only detail, not its chat or day header. */
export function SavedEventListCard({event,locale,t,onOpen,hasAnalysis}:{
  event:CafeEvent;locale:Locale;t:T;onOpen:(event:CafeEvent)=>void;hasAnalysis:boolean;
}){
  return <article className="min-w-0 rounded-2xl border border-line bg-card">
    <button type="button" onClick={()=>onOpen(event)}
      aria-label={t("openEvent",{title:event.name,date:dateLabel(event.startDate,locale,"long")})}
      className="flex min-h-20 w-full min-w-0 items-center gap-3 rounded-2xl p-4 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[15px] font-semibold text-accent-text">
          <CalendarDays size={16} className="me-1 inline align-[-3px]" aria-hidden="true"/>
          {dateLabel(event.startDate,locale,"long")}
          {event.endDate!==event.startDate?" – "+dateLabel(event.endDate,locale,"long"):""}
          {event.startTime?" · "+event.startTime:""}
        </p>
        <h4 className="break-words font-headline text-[19px] font-bold leading-snug text-ink" dir="auto">{event.name}</h4>
        {(event.venue||event.areaLabel)&&<p className="break-words text-[16px] text-ink-muted" dir="auto">{event.venue??event.areaLabel}</p>}
        {event.status!=="found"&&<p role="status" className="font-semibold text-warn-text">
          {event.status==="cancelled"?t("cancelled"):t("moved")}
        </p>}
        <p className="text-[15px] font-semibold text-accent-text">{t(hasAnalysis?"readInsights":"viewEventDetails")}</p>
      </div>
      <ChevronRight size={22} className="shrink-0 text-accent-text rtl:rotate-180" aria-hidden="true"/>
    </button>
  </article>;
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

/** Existing AI proposal is date-scoped; never misrepresent it as verified event-specific analysis. */
export function SavedEventAnalysis({plan,selectedEvent,date,today,currency,locale,t,onChat,
  cityCoverage,neighborhoodCoverage}:{
  plan:Plan|undefined;selectedEvent:CafeEvent|null;date:string;today:string;currency:string|null;
  locale:Locale;t:T;onChat:()=>void;cityCoverage?:CityCoverageOverview;
  neighborhoodCoverage?:SavedEventTimeline["neighborhoodCoverage"];
}){
  if(!plan)return <p className="rounded-xl bg-surface2 p-4 text-ink-muted">
    {selectedEvent?t("noEventInsight"):t("noPlan")}
  </p>;
  const actions=actionsFor(plan);
  return <section className="space-y-4 rounded-2xl border border-line bg-card p-4" aria-label={t("savedInsight")}>
    <div>
      <p className="text-[15px] font-semibold text-accent-text">{t("savedInsight")}{plan.importance?" · "+t("importance"+plan.importance.charAt(0).toUpperCase()+plan.importance.slice(1)):""}</p>
      {selectedEvent&&(!plan.eventIds||plan.eventIds.length===0)&&<p className="mt-1 text-[15px] text-ink-muted">{t("dayWideInsight",{date:dateLabel(date,locale,"long")})}</p>}
      <p className="mt-2 break-words font-headline text-[20px] font-semibold leading-snug" dir="auto">{plan.summary}</p>
    </div>
    <div className="rounded-xl bg-surface2 p-3 text-[15px]" aria-label={t("outlookUncertainty")}>
      <h4 className="font-semibold">{t("outlookUncertainty")}</h4>
      <p>{t("demandUnknown")}</p>
      {cityCoverage&&cityCoverage.status!=="complete"&&<p className="mt-1">{t("cityCoverageIncomplete")}</p>}
      {neighborhoodCoverage?.some(scope=>scope.retryEligible||scope.status==="partial"||
        scope.status==="failed")&&<p className="mt-1">{t("neighborhoodIncomplete")}</p>}
    </div>
    <PlanHours plan={plan} t={t}/>
    {actions.length>0&&<div className="space-y-2">
      <h4 className="font-bold">{t("recommendations")}</h4>
      <ul className="grid gap-3 sm:grid-cols-2">{actions.map((action,index)=>
        <EventAdviceItem key={index} action={action}/>)}</ul>
    </div>}
    {date===today&&liveEventHeadline(plan,date,t)&&<section aria-label={t("liveObservations")} className="rounded-xl bg-surface2 p-3">
      <h4 className="font-bold">{t("liveObservations")}</h4>
      <p role="status">{liveEventHeadline(plan,date,t)}</p>
    </section>}
    <EventReportCard report={plan.report} status={plan.reportStatus}
      currency={currency} locale={locale} t={t} onChat={onChat}/>
  </section>;
}


/** City browsing consumes only the existing saved Events API and its canonical
 * paginated catalog. Opening the panel never starts OpenAI research. */
export function CityCatalogView({today,locale,t,chatDisabled,onAsk}:{
  today:string;locale:Locale;t:T;chatDisabled:boolean;
  onAsk:(item:CityCatalogPage["items"][number])=>void;
}){
  const [month,setMonth]=useState(today.slice(0,7));
  const [page,setPage]=useState(0);
  const [kind,setKind]=useState("");
  const [searchInput,setSearchInput]=useState("");
  const [search,setSearch]=useState("");
  const [catalog,setCatalog]=useState<CityCatalogPage|null>(null);
  const [coverage,setCoverage]=useState<CityCoverageOverview|null>(null);
  const [selected,setSelected]=useState<CityCatalogPage["items"][number]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [retry,setRetry]=useState(0);
  const from=month+"-01",to=cityMonthEnd(month);
  useEffect(()=>{
    const controller=new AbortController();
    const params=new URLSearchParams({cityFrom:from,cityTo:to,cityPage:String(page),
      cityPageSize:"25"});
    if(kind)params.set("cityKind",kind);
    if(search)params.set("citySearch",search);
    void fetch("/api/events/saved?"+params.toString(),{
      cache:"no-store",signal:controller.signal,
    }).then(async response=>{
      if(!response.ok)throw new Error("city_catalog_unavailable");
      const data=await response.json() as Timeline;
      if(!data.cityCatalog||!Array.isArray(data.cityCatalog.items)||
        data.cityCatalog.page!==page||data.cityCatalog.pageSize!==25)
        throw new Error("invalid_city_catalog");
      if(!controller.signal.aborted){
        setCatalog(data.cityCatalog);setCoverage(data.cityCoverage??null);
        setLoading(false);
      }
    }).catch(()=>{if(!controller.signal.aborted){setError(true);setLoading(false);}});
    return ()=>controller.abort();
  },[from,to,page,kind,search,retry]);

  const choices=["","festival","conference","sports","parade","community","other"];
  // Only input actions reset the loading state; the effect performs the fetch.
  const beginRefresh=()=>{setLoading(true);setError(false);};
  const changeMonth=(delta:number)=>{
    beginRefresh();
    setMonth(current=>nextMonth(current,delta));setPage(0);setSelected(null);
  };
  const applySearch=()=>{
    beginRefresh();
    setSearch(searchInput.trim().slice(0,80));setPage(0);setSelected(null);
    // Search can intentionally recheck the same saved filter.
    setRetry(v=>v+1);
  };
  const button="min-h-12 rounded-xl border border-line bg-surface2 px-3 text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40";
  const checked=(value:string|null|undefined)=>value&&/^\d{4}-\d{2}-\d{2}/.test(value)?
    dateLabel(value.slice(0,10),locale,"long"):t("researchUnknown");
  const status=(item:CityCatalogPage["items"][number])=>item.status==="cancelled"?
    t("cancelled"):item.status==="moved"?t("moved"):
    item.status==="found"&&item.lastVerifiedAt?t("listedVerified"):t("sourceStatusUnknown");
  if(selected)return <div className="space-y-4" data-testid="city-event-detail">
    <button type="button" className={button} onClick={()=>setSelected(null)}>
      <ChevronLeft size={18} className="me-1 inline rtl:rotate-180" aria-hidden="true"/>{t("backToCity")}
    </button>
    <article className="space-y-3 rounded-2xl border border-line bg-card p-4">
      <p className="font-semibold text-accent-text">{dateLabel(selected.startDate,locale,"long")}
        {selected.endDate!==selected.startDate?" – "+dateLabel(selected.endDate,locale,"long"):""}
        {selected.startTime?" · "+selected.startTime:""}
      </p>
      <h4 className="break-words font-headline text-[22px] font-bold" dir="auto">{selected.name}</h4>
      <p>{t("category")}: {cityKindLabel(selected.kind,t)}</p>
      <p className="text-ink-muted">{selected.venue??t("venueUnknown")}</p>
      <VenueMapLink address={selected.venueAddress} t={t}/>
      <p className="text-[15px] text-ink-muted">{t("sourceStatus")}: {status(selected)}</p>
      <p className="text-[15px] text-ink-muted">{t("researchedOn",{date:checked(selected.checkedAt)})}</p>
      {selected.sources.some(source=>sourceUrl(source.url))?<ul className="space-y-2">
        {selected.sources.filter(source=>sourceUrl(source.url)).map(source=><li key={source.url} className="break-all">
          <a href={source.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-h-12 items-center text-accent-text underline">
            {t("source")} · {source.url}
          </a>
          <p className="text-[15px] text-ink-muted">{t("researchedOn",{date:checked(source.observedAt)})}</p>
        </li>)}
      </ul>:<p className="text-ink-muted">{t("sourceUnknown")}</p>}
      <p className="text-[15px] text-ink-muted">{t("cityUnknownDemand")}</p>
      <button type="button" disabled={chatDisabled} onClick={()=>onAsk(selected)}
        className="min-h-12 w-full rounded-xl bg-accent px-4 py-2 font-semibold text-on-accent disabled:opacity-50">
        {t("askCitySupervisor")}
      </button>
    </article>
  </div>;

  return <div className="space-y-4" data-testid="city-events-catalog">
    <p className="text-[16px] text-ink-muted">{t("cityCatalogScope")}</p>
    <div className="flex items-center justify-between gap-2 rounded-xl bg-surface2 p-2">
      <button type="button" className={button} onClick={()=>changeMonth(-1)}
        aria-label={t("previousMonth")}><ChevronLeft className="rtl:rotate-180" aria-hidden="true"/></button>
      <h4 className="text-center font-bold">{new Intl.DateTimeFormat(locale,{
        timeZone:"UTC",month:"long",year:"numeric",
      }).format(new Date(from+"T00:00:00Z"))}</h4>
      <button type="button" className={button} onClick={()=>changeMonth(1)}
        aria-label={t("nextMonth")}><ChevronRight className="rtl:rotate-180" aria-hidden="true"/></button>
    </div>
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={event=>{event.preventDefault();applySearch();}}>
      <label className="min-w-0 flex-1">
        <span className="mb-1 block font-semibold">{t("searchEvents")}</span>
        <input type="search" maxLength={80} value={searchInput} onChange={e=>setSearchInput(e.target.value)}
          className="min-h-12 w-full min-w-0 rounded-xl border border-line bg-card px-3 text-[17px]"
          placeholder={t("searchEvents")}/>
      </label>
      <label className="min-w-0 flex-1">
        <span className="mb-1 block font-semibold">{t("category")}</span>
        <select value={kind} onChange={e=>{beginRefresh();setKind(e.target.value);setPage(0);}}
          className="min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]">
          {choices.map(choice=><option key={choice} value={choice}>{choice?cityKindLabel(choice,t):t("allCategories")}</option>)}
        </select>
      </label>
      <button type="submit" className={button+" self-end"}>{t("searchButton")}</button>
    </form>
    {coverage&&<div role="status" className="rounded-xl bg-surface2 p-3 text-[15px]">
      <p className="font-semibold">{t(coverage.status==="complete"?"cityCoverageRecorded":"cityCoverageIncomplete")}</p>
      <p>{t("cityCoverageCounts",{checked:coverage.researchedSourceWindows,
        failed:coverage.failedSourceWindows+coverage.partialSourceWindows+
          coverage.unsearchedSourceWindows})}</p>
      {coverage.lastCompletedAt&&<p>{t("researchedOn",{date:checked(coverage.lastCompletedAt)})}</p>}
    </div>}
    {loading?<p role="status">{t("loading")}</p>:
      error?<div role="alert" className="space-y-2">
        <p>{t("loadFailed")}</p>
        <button type="button" onClick={()=>{beginRefresh();setRetry(v=>v+1);}} className={button}>{t("retry")}</button>
      </div>:
      !catalog?.available?<p role="status" className="rounded-xl bg-surface2 p-4">{t("cityUnavailable")}</p>:
      <>
        <p className="text-[15px] text-ink-muted" role="status">{t("cityResults",{
          count:catalog.total,first:catalog.total===0?0:catalog.page*catalog.pageSize+1,
          last:Math.min(catalog.total,(catalog.page+1)*catalog.pageSize)})}</p>
        {catalog.items.length===0&&<p className="rounded-xl bg-surface2 p-4">{t("cityNoResults")}</p>}
        <ul className="space-y-3">{catalog.items.map(item=><li key={item.id}>
          <button type="button" onClick={()=>setSelected(item)}
            className="w-full min-h-20 rounded-2xl border border-line bg-card p-4 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <p className="text-[15px] font-semibold text-accent-text">
              {dateLabel(item.startDate,locale,"long")} · {cityKindLabel(item.kind,t)}
            </p>
            <h5 className="mt-1 break-words text-[19px] font-bold" dir="auto">{item.name}</h5>
            <p className="mt-1 break-words text-[16px] text-ink-muted" dir="auto">
              {item.venue??t("venueUnknown")}
            </p>
            <p className="text-[15px] text-ink-muted">{status(item)} · {t("researchedOn",{date:checked(item.checkedAt)})}</p>
          </button>
        </li>)}</ul>
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={button} disabled={catalog.page===0}
            onClick={()=>{beginRefresh();setPage(p=>Math.max(0,p-1));}}>{t("previousPage")}</button>
          <span className="text-[15px]">{t("pageNumber",{page:catalog.page+1})}</span>
          <button type="button" className={button} disabled={!catalog.hasMore}
            onClick={()=>{beginRefresh();setPage(p=>p+1);}}>{t("nextPage")}</button>
        </div>
      </>}
  </div>;
}

/** Opens over the same Supervisor conversation. Reads saved PR 3 facts and loop plans only. */
export default function SavedEventsCard({locale,chatDisabled,compact=false,onChatAboutDay}:{
  locale:Locale;chatDisabled:boolean;compact?:boolean;
  onChatAboutDay:(date:string,title:string,eventId?:string,existingThreadId?:string,
    cityEventId?:string,draftPrompt?:string)=>void;
}){
  const t=useMemo(()=>createTranslator({locale,messages:{en,es,ar}[locale],namespace:"EventsPanel"}) as unknown as T,[locale]);
  const [timeline,setTimeline]=useState<Timeline|null>(null);
  const [error,setError]=useState(false);
  const [panel,setPanel]=useState<Panel>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedEventId,setSelectedEventId]=useState<string|null>(null);
  const [tab,setTab]=useState<Tab>("upcoming");
  const [view,setView]=useState<View>("cafe");
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
  if(!timeline)return <section data-testid="coming-up" aria-label={t("title")}
    className="space-y-2 rounded-2xl border border-line bg-card p-4 text-[17px] text-ink" role="status">
      <p>{error?t("loadFailed"):t("loading")}</p>
      {error&&<button type="button" onClick={()=>{setError(false);void refresh().catch(()=>setError(true));}}
        className="min-h-12 rounded-xl bg-accent px-4 font-semibold text-on-accent">{t("retry")}</button>}
    </section>;

  const today=timeline.today;
  const days=eventStripDays(today);
  const lead=days.map(date=>({date,plan:planOn(timeline.plans,date),
    events:cafeHighlightedEvents(timeline,date)}))
    .find(d=>Boolean(d.plan));
  const openDay=(date:string,eventId:string|null=null)=>{
    setView("cafe");setSelected(date);setSelectedEventId(eventId);setPanel("day");
    setTab(date<today?"past":date===today?"now":"upcoming");setMonth(date.slice(0,7));
  };
  const openEvent=(event:CafeEvent,viewDate:string)=>openDay(eventDetailDay(event,viewDate),event.id);
  const openEvents=(next:Tab="upcoming")=>{setView("cafe");setPanel("events");setSelected(null);setSelectedEventId(null);setTab(next);setMonth(today.slice(0,7));};
  const chosen=selected??today;
  const allDayEvents=cafeHighlightedEvents(timeline,chosen);
  const selectedEvent=selectedSavedEvent(timeline.events,chosen,selectedEventId);
  const plan=selectedEventId?
    (selectedEvent?eventPlanFor(timeline.plans,selectedEvent.id,chosen):undefined):
    planOn(timeline.plans,chosen);
  const dayEvents=selectedEvent?[selectedEvent]:allDayEvents;
  const calendarMonth=month??today.slice(0,7);
  const calendarFirst=calendarMonth+"-01";
  const weekday=new Date(calendarFirst+"T00:00:00Z").getUTCDay();
  const monthLength=new Date(Number(calendarMonth.slice(0,4)),Number(calendarMonth.slice(5,7)),0).getDate();
  const calendarDays=Array.from({length:weekday+monthLength},(_,i)=>i<weekday?null:
    calendarMonth+"-"+String(i-weekday+1).padStart(2,"0"));
  const button="min-h-12 rounded-xl px-4 text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50";
  const chat=(date:string,event?:CafeEvent)=>{
    if(chatDisabled)return;
    const target=eventChatTarget(date,event,planOn(timeline.plans,date));
    onChatAboutDay(target.date,target.title,target.eventId,target.existingThreadId);
    setPanel(null);
  };
  const askCity=(item:CityCatalogPage["items"][number])=>{
    if(chatDisabled)return;
    const target=cityEventChatTarget(item);
    const prompt=t("askCityPrompt",{title:item.name,date:item.startDate,
      source:item.sources[0]?.url??t("sourceUnknown")});
    onChatAboutDay(target.date,target.title,target.eventId,undefined,target.cityEventId,prompt);
    setPanel(null);
  };
  const listDates=eventListDays(timeline,tab,true,sortByDate);
  const visibleEvents=(date:string)=>cafeHighlightedEvents(timeline,date).filter(e=>{
    const from=tab==="past"?dayAt(today,-14):tab==="now"?today:dayAt(today,1);
    return e.startDate<=date&&e.endDate>=date&&(e.startDate===date||(e.startDate<from&&date===from));
  });
  return <>
    <section data-testid="coming-up" aria-label={t("title")}
      className="min-w-0 rounded-2xl border border-line bg-card p-3">
      <button type="button" onClick={()=>openEvents()}
        className="flex min-h-12 w-full items-center gap-2 text-start font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <CalendarDays size={20} aria-hidden="true"/><span className="flex-1 text-[17px]">{t("title")}</span>
        <span className="text-[15px] text-accent-text">{t("seeAll")}</span>
      </button>
      <div className="mt-2"><EventsTabs tab={tab} onChoose={openEvents} t={t}/></div>
      {!compact&&(lead?<button type="button" onClick={()=>openDay(lead.date)}
        className="mb-3 w-full min-w-0 rounded-2xl bg-surface2 p-3 text-start disabled:opacity-60">
        <p className="text-[15px] font-semibold text-accent-text">{dateLabel(lead.date,locale,"long")} · {lead.date===today?t("now"):t("upcoming")}</p>
        <h3 className="mt-1 break-words font-headline text-[20px] font-bold leading-snug text-ink" dir="auto">
          {lead.events.map(e=>e.name).join(" · ")||t("savedInsight")}
        </h3>
        {lead.events.filter(e=>e.status!=="found").map(e=><p key={e.id} role="alert"
          className="mt-2 rounded-lg bg-card p-2 font-semibold text-warn-text">
          {e.name}: {e.status==="cancelled"?t("cancelled"):t("moved")}
        </p>)}
        {lead.events[0]?.venue&&<p className="mt-1 break-words text-[15px] text-ink-muted" dir="auto">{lead.events[0].venue}</p>}
        {lead.plan?.summary&&<p className="mt-2 line-clamp-3 text-[17px] leading-relaxed text-ink" dir="auto">{lead.plan.summary}</p>}
        {lead.date===today&&liveEventHeadline(lead.plan,today,t)&&<p className="mt-2 rounded-xl bg-card p-2 text-[17px]">{liveEventHeadline(lead.plan,today,t)}</p>}
        <span className="mt-2 inline-flex min-h-12 items-center font-semibold text-accent-text">{t("readInsights")} <ChevronRight size={19} className="ms-1 rtl:rotate-180" aria-hidden="true"/></span>
      </button>:<p className="mb-3 text-[17px] leading-snug text-ink-muted">{t("noCafeOutlook")}</p>)}
      {!compact&&<div className="grid grid-cols-7 gap-1">
        {days.map(date=>{
          const dayPlan=planOn(timeline.plans,date);
          const events=cafeHighlightedEvents(timeline,date);
          const name=dateLabel(date,locale);
          return <button key={date} type="button" onClick={()=>openDay(date)}
            aria-label={name+" · "+(dayPlan?.summary??events.map(e=>e.name).join(", ")??"")}
            className="flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-xl bg-surface2 px-0.5 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
            <span className="text-[13px]">{new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(new Date(date+"T00:00:00Z"))}</span>
            <span className="text-[17px] font-bold">{date.slice(8)}</span>
            <span aria-hidden="true" className={"h-2 w-2 rounded-full "+(dayPlan?"bg-accent":events.length?"bg-warn-text":"bg-line")}/>
          </button>;
        })}
      </div>}
    </section>
    {panel&&<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center"
      role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setPanel(null);}}>
      <section role="dialog" aria-modal="true" aria-label={view==="city"?t("allCityEvents"):panel==="day"?(selectedEvent?.name??dateLabel(chosen,locale,"long")):t("title")}
        dir={locale==="ar"?"rtl":"ltr"}
        className="flex max-h-[94dvh] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-surface text-ink shadow-xl md:max-h-[90dvh] md:rounded-3xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-line p-3">
          {panel==="day"&&<button type="button" onClick={()=>openEvents(tab)} aria-label={t("back")}
            className={button}><ChevronLeft size={20} className="rtl:rotate-180" aria-hidden="true"/></button>}
          <h3 className="min-w-0 flex-1 break-words font-headline text-[20px] font-bold">{view==="city"?t("allCityEvents"):panel==="day"?(selectedEvent?.name??dateLabel(chosen,locale,"long")):t("title")}</h3>
          <button type="button" onClick={()=>setPanel(null)} aria-label={t("close")} className={button}>
            <X size={22} aria-hidden="true"/></button>
        </header>
        {panel==="events"&&<div role="group" aria-label={t("viewChoice")}
          className="grid shrink-0 grid-cols-2 gap-2 border-b border-line p-3">
          {(["cafe","city"] as const).map(choice=><button key={choice} type="button"
            aria-pressed={view===choice} onClick={()=>setView(choice)}
            className={button+(view===choice?" bg-accent text-on-accent":" bg-surface2")}>
            {t(choice==="cafe"?"forMyCafe":"allCityEvents")}
          </button>)}
        </div>}
        {view==="cafe"&&<div className="shrink-0 border-b border-line p-3">
          <EventsTabs tab={tab} onChoose={next=>{setTab(next);setPanel("events");}} t={t}/>
        </div>}
        <div className="min-h-0 min-w-0 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain p-3 text-[17px] leading-relaxed sm:p-5">
          {panel==="events"&&view==="city"?<CityCatalogView today={today} locale={locale} t={t}
            chatDisabled={chatDisabled} onAsk={askCity}/>:
            panel==="events"?<>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className={button+" bg-surface2"} onClick={()=>setCalendar(v=>!v)}
                aria-expanded={calendar}><CalendarDays size={19} className="me-2 inline" aria-hidden="true"/>{t("calendar")}</button>
              <p className="text-[15px] text-ink-muted">{t("cafeSelectedHint")}</p>
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
                {saved.map(event=><SavedEventListCard key={event.id} event={event} locale={locale} t={t}
                  hasAnalysis={Boolean(eventPlanFor(timeline.plans,event.id,date))}
                  onOpen={event=>openEvent(event,date)}/>)}
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
              <p className="font-semibold text-accent-text"><CalendarDays size={18} className="me-2 inline" aria-hidden="true"/>{dateLabel(event.startDate,locale,"long")}{event.endDate!==event.startDate?" – "+dateLabel(event.endDate,locale,"long"):""}{event.startTime?" · "+event.startTime:""}</p>
              {(event.venue||event.areaLabel)&&<p className="break-words text-ink-muted" dir="auto">{event.venue??event.areaLabel}</p>}
              {event.verificationFailedAt&&(!event.lastVerifiedAt||event.verificationFailedAt>event.lastVerifiedAt)&&
                <p className="text-[15px] text-ink-muted">{t("verificationPending")}</p>}
              {event.lastVerifiedAt&&<p className="text-[15px] text-ink-muted">{t("verifiedOn",{date:event.lastVerifiedAt.slice(0,10)})}</p>}
              <VenueMapLink address={event.venueAddress} t={t}/>
              {[...new Set([event.sourceUrl,...(event.sourceUrls??[])]
                .filter((url):url is string=>Boolean(sourceUrl(url))))].map((url,index,all)=>
                <a key={url} className="inline-flex min-h-12 max-w-full break-all items-center text-accent-text underline"
                  href={url} target="_blank" rel="noopener noreferrer">
                  {t("source")}{all.length>1?" "+(index+1):""}
                </a>)}
              <p className="text-[15px] text-ink-muted">{t("researchedOn",{date:event.lastCheckedAt.slice(0,10)})}</p>
              {!selectedEvent&&<button type="button" onClick={()=>chat(chosen,event)} disabled={chatDisabled}
                className={button+" ms-3 text-accent-text underline"}>{t("chatAbout")}</button>}
            </article>)}
            <SavedEventAnalysis plan={plan} selectedEvent={selectedEvent} date={chosen}
              today={today} currency={timeline.currency??null} locale={locale} t={t}
              cityCoverage={timeline.cityCoverage} neighborhoodCoverage={timeline.neighborhoodCoverage}
              onChat={()=>chat(chosen,selectedEvent??undefined)}/>
            {dayEvents.length===0&&!plan&&<p className="text-ink-muted">{t("noEvents")}</p>}
            <button type="button" onClick={()=>chat(chosen,selectedEvent??undefined)} disabled={chatDisabled}
              className={button+" w-full bg-accent text-on-accent"}>{t("chatAbout")}</button>
          </>}
        </div>
      </section>
    </div>}
  </>;
}
