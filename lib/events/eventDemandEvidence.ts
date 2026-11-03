import {MIN_TYPICAL_SAMPLE,typicalDaySales,typicalHourlySales} from "../metrics/core/dayOutlook";
import {hourlyMatchesDaily,indexHourlyRevenue} from "../metrics/core/eventReadiness";
import type {DailyFacts} from "../calc";
import type {Hour} from "../data/posFactReaders.server";
import type {CafeEvent} from "../data/cafeEvents.server";
import type {OwnerProposalRow,OwnerReportRow} from "../ai/supervisor/loop/reads.server";
import type {SavedFact} from "../ownerFacts/inject";

/** Facts for the existing Supervisor, not a prediction or a new money metric.
 * Every cents amount is copied from a canonical reader or calculated by an
 * existing core outlook function. A difference is NEVER attributed to an event. */
export type EventDemandRequest={eventDate:string;asOfDate:string;eventIds?:readonly string[];
  eventNames?:readonly string[]};
export type EventDemandSample={proposal_id:string;business_date:string;
  observation:unknown;evidence_source:string};
export type EventDemandEvidence={
  eventDate:string;asOfDate:string;source:"canonical_cafe_performance";
  normal:{netSalesCents:number|null;sampleDays:number;requiredDays:number;
    from:string;to:string;status:"actual"|"partial"|"missing";source:"daily_rollups"};
  observed:{date:string;netSalesCents:number;coverage:"actual"|"provisional";
    asOf:string|null;source:"daily_rollups"|"toast_today_live"}|null;
  usualHours:Array<{hourLocal:number;netSalesCents:number;sampleDays:number}>;
  priorOutcomes:Array<{proposalId:string;matchedBy:"event_id"|"event_name";
    startDate:string;reportStatus:string;observedDays:number|null;expectedDays:number|null;
    days:Array<{date:string;actualCents:number|null;typicalCents:number|null}>;
    observations:Array<{date:string;coverage:"actual"|"provisional";
      actualCents:number;typicalCents:number|null;source:string}>}>;
  currentObservations:Array<{date:string;coverage:"actual"|"provisional";
    actualCents:number;typicalCents:number|null;source:string}>;
  ownerObservations:Array<{key:string;value:unknown;recordedAt:string;origin:"owner_reported"}>;
  otherKnownEvents:string[];
  coverage:{dailyActualDays:number;hourlyReconciledDays:number;missing:string[];caveats:string[]};
  attribution:"not_established";
};

const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
export function checkedEventDemandRequest(input:EventDemandRequest):EventDemandRequest{
  const valid=(v:string)=>dayPattern.test(v)&&!Number.isNaN(Date.parse(v+"T00:00:00Z"))&&
    new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v;
  if(!valid(input.eventDate)||!valid(input.asOfDate))throw new Error("invalid_event_evidence_date");
  const ids=input.eventIds??[],names=input.eventNames??[];
  if(ids.length>8||names.length>8||ids.some(v=>typeof v!=="string"||!v||v.length>128)||
    names.some(v=>typeof v!=="string"||!v.trim()||v.length>200))
    throw new Error("invalid_event_evidence_scope");
  return input;
}
export function eventDemandWindow(input:EventDemandRequest){
  checkedEventDemandRequest(input);
  const add=(date:string,delta:number)=>{
    const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+delta);
    return d.toISOString().slice(0,10);
  };
  // Compare like weekdays using the last eight CLOSED days/weeks available.
  // Never include the event day in its own pre-event baseline.
  const before=input.eventDate<=input.asOfDate?input.eventDate:add(input.asOfDate,1);
  const through=add(before,-1);
  return {from:add(before,-56),through,before,
    dailyThrough:input.eventDate<=input.asOfDate?input.eventDate:through};
}
const normalized=(s:string)=>s.trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");
const obj=(v:unknown):Record<string,unknown>|null=>
  v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const integer=(v:unknown):number|null=>typeof v==="number"&&Number.isSafeInteger(v)?v:null;
function matches(proposal:OwnerProposalRow,request:EventDemandRequest):"event_id"|"event_name"|null{
  const payload=obj(proposal.canonical_effect_payload);
  const facts=Array.isArray(payload?.facts)?payload.facts:[];
  const ids=new Set(request.eventIds??[]),names=new Set((request.eventNames??[]).map(normalized));
  const identifiers=Array.isArray(payload?.eventIds)?payload.eventIds:[];
  if(identifiers.some(id=>typeof id==="string"&&ids.has(id)))return "event_id";
  if(facts.some(f=>{const v=obj(f);return typeof v?.id==="string"&&ids.has(v.id);}))return "event_id";
  if(facts.some(f=>{const v=obj(f);return typeof v?.name==="string"&&names.has(normalized(v.name));}))
    return "event_name";
  return null;
}
/** Same selection is used before the scoped report/sample reads and on assembly. */
export function relevantEventDemandProposals(proposals:readonly OwnerProposalRow[],
  input:EventDemandRequest){
  return proposals.filter(p=>p.capability_id==="alex.event_readiness.v1").flatMap(p=>{
    const method=matches(p,input),effect=obj(p.canonical_effect_payload);
    const start=effect?.startDate,end=effect?.endDate;
    return method&&typeof start==="string"&&typeof end==="string"&&
      dayPattern.test(start)&&dayPattern.test(end)&&start<=end&&start<=input.eventDate
      ?[{proposal:p,method,start,end}]:[];
  });
}
function safeObservations(samples:readonly EventDemandSample[],proposalId:string,through:string){
  return samples.filter(s=>s.proposal_id===proposalId&&s.business_date<=through)
    .flatMap(s=>{
      const observation=obj(s.observation),actual=integer(observation?.actualCents);
      const coverage=observation?.coverage;
      if(!dayPattern.test(s.business_date)||actual===null||
        (coverage!=="actual"&&coverage!=="provisional"))return [];
      return [{date:s.business_date,coverage:coverage as "actual"|"provisional",actualCents:actual,
        typicalCents:integer(observation?.typicalCents),source:s.evidence_source}];
    }).sort((a,b)=>a.date.localeCompare(b.date)).slice(-6);
}
/** Pure, fixture-testable adapter over existing readers. It does not query or write. */
export function assembleEventDemandEvidence(input:EventDemandRequest,sources:{
  daily:readonly DailyFacts[];hourly:readonly Hour[];baselineEvents:readonly CafeEvent[];
  dayEvents:readonly CafeEvent[];proposals:readonly OwnerProposalRow[];
  reports:readonly OwnerReportRow[];samples:readonly EventDemandSample[];
  ownerFacts:readonly SavedFact[];live?:{netSalesCents:number;businessDate:string;
    readAt:string;ageMs:number;truncated:boolean;unparsedOrders:number;locationsFailed:number}|null;
  missing?:readonly string[];caveats?:readonly string[];
}):EventDemandEvidence{
  checkedEventDemandRequest(input);
  const window=eventDemandWindow(input);
  const certified=sources.daily.filter(d=>d.salesDataStatus==="actual"&&
    Number.isSafeInteger(d.netSalesCents)&&d.netSalesCents>=0);
  const excluded=new Set<string>();
  for(const event of sources.baselineEvents.filter(e=>e.status==="found")){
    for(let d=event.startDate,steps=0;d<=event.endDate&&steps<90;steps++){
      if(d>=window.from&&d<=window.through)excluded.add(d);
      const next=new Date(d+"T00:00:00Z");next.setUTCDate(next.getUTCDate()+1);
      d=next.toISOString().slice(0,10);
    }
  }
  const comparable=certified.filter(d=>d.date>=window.from&&d.date<=window.through);
  const usual=typicalDaySales(comparable,input.eventDate,window.before,{exclude:excluded});
  const missing=[...(sources.missing??[])];
  const caveats=[...(sources.caveats??[])];
  if(usual.typicalCents===null)missing.push("insufficient_comparable_actual_weekdays");
  const onDay=certified.find(d=>d.date===input.eventDate);
  const live=sources.live;
  const validLive=live&&input.eventDate===input.asOfDate&&
    live.businessDate===input.eventDate&&live.ageMs<=20*60_000&&
    !live.truncated&&live.unparsedOrders===0&&live.locationsFailed===0&&
    Number.isSafeInteger(live.netSalesCents)&&live.netSalesCents>=0&&
    !Number.isNaN(Date.parse(live.readAt));
  const observed=onDay?{date:input.eventDate,netSalesCents:onDay.netSalesCents,
    coverage:"actual" as const,asOf:null,source:"daily_rollups" as const}:
    validLive?{date:input.eventDate,netSalesCents:live.netSalesCents,
      coverage:"provisional" as const,asOf:live.readAt,source:"toast_today_live" as const}:null;
  if(!observed&&input.eventDate<=input.asOfDate)missing.push("event_day_sales_not_available");
  if(live&&input.eventDate===input.asOfDate&&!onDay&&!validLive)
    caveats.push("live_reading_incomplete_or_stale");

  let usualHours:EventDemandEvidence["usualHours"]=[],hourlyReconciledDays=0;
  if(!missing.includes("hourly_source_unavailable")&&!missing.includes("hourly_source_truncated")){
    try{
      const grouped=indexHourlyRevenue(sources.hourly);
      const fullDays=new Set(comparable.filter(d=>
        hourlyMatchesDaily(grouped.get(d.date),d.netSalesCents)).map(d=>d.date));
      hourlyReconciledDays=fullDays.size;
      usualHours=typicalHourlySales(sources.hourly.filter(h=>fullDays.has(h.date)),
        input.eventDate,window.before,{exclude:excluded})
        .map(h=>({hourLocal:h.hourLocal,netSalesCents:h.typicalCents,sampleDays:h.sampleDays}));
    }catch{missing.push("hourly_source_invalid");}
  }
  if(!usualHours.length)missing.push("hourly_pattern_not_verified");

  const matched=relevantEventDemandProposals(sources.proposals,input);
  const reports=new Map(sources.reports.map(r=>[r.proposal_id,r]));
  const previous=matched.filter(p=>p.end<input.eventDate&&reports.has(p.proposal.id)).slice(0,3);
  const priorOutcomes=previous.map(({proposal,method,start})=>{
    const row=reports.get(proposal.id)!;
    const data=obj(row.report);
    const days=(Array.isArray(data?.days)?data.days:[]).slice(-7).flatMap(raw=>{
      const d=obj(raw);if(typeof d?.date!=="string"||!dayPattern.test(d.date))return [];
      return [{date:d.date,actualCents:integer(d.actualCents),
        typicalCents:integer(d.typicalCents)}];
    });
    return {proposalId:proposal.id,matchedBy:method,startDate:start,reportStatus:row.status,
      observedDays:integer(data?.observedDays),expectedDays:integer(data?.expectedDays),days,
      observations:safeObservations(sources.samples,proposal.id,input.asOfDate)};
  });
  const current=matched.filter(p=>p.start<=input.eventDate&&p.end>=input.eventDate)
    .slice(0,2).flatMap(p=>safeObservations(sources.samples,p.proposal.id,input.asOfDate))
    .filter(s=>s.date===input.eventDate).slice(0,2);
  const ids=new Set(input.eventIds??[]),names=new Set((input.eventNames??[]).map(normalized));
  const otherKnownEvents=[...new Set(sources.dayEvents.filter(e=>e.status==="found"&&
    e.startDate<=input.eventDate&&e.endDate>=input.eventDate&&!ids.has(e.id)&&
    !names.has(normalized(e.name))).map(e=>e.name))].slice(0,5);
  if(otherKnownEvents.length)caveats.push("other_events_on_same_day_not_controlled_for");
  const outcomes=sources.ownerFacts.filter(f=>f.fact_key.startsWith("event_outcome:"));
  const ranked=[...outcomes].sort((a,b)=>{
    const relevant=(f:SavedFact)=>[input.eventDate,...(input.eventIds??[]),...(input.eventNames??[])]
      .some(key=>f.fact_key.toLocaleLowerCase().includes(key.toLocaleLowerCase()));
    return Number(relevant(b))-Number(relevant(a))||b.created_at.localeCompare(a.created_at);
  });
  const compactOwnerValue=(value:unknown)=>{
    const serialized=JSON.stringify(value);
    return serialized&&serialized.length>240?{excerpt:serialized.slice(0,240),truncated:true}:value;
  };
  return {eventDate:input.eventDate,asOfDate:input.asOfDate,source:"canonical_cafe_performance",
    normal:{netSalesCents:usual.typicalCents,sampleDays:usual.sampleDays,
      requiredDays:MIN_TYPICAL_SAMPLE,from:usual.from,to:usual.to,
      status:usual.typicalCents===null?"missing":missing.length||caveats.length?"partial":"actual",
      source:"daily_rollups"},
    observed,usualHours,priorOutcomes,currentObservations:current,
    ownerObservations:ranked.slice(0,6).map(f=>({key:f.fact_key,value:compactOwnerValue(f.value_json),
      recordedAt:f.created_at,origin:"owner_reported" as const})),otherKnownEvents,
    coverage:{dailyActualDays:comparable.length,hourlyReconciledDays,missing:[...new Set(missing)],
      caveats:[...new Set([...caveats,"observed_sales_do_not_establish_event_causation"]) ]},
    attribution:"not_established"};
}
