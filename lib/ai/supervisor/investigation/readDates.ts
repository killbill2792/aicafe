import {z} from "zod";
import {resolveCafeDateRange,type DateSelection} from "@/lib/ai/conversations/dateRange";
import {parseOwnerDateWindows} from "@/lib/ai/conversations/ownerDateIntent";
import type {InvestigationMemory,InvestigationCalendarScope} from "@/lib/ai/conversations/investigationMemory";
import {hasOwnerScheduleDates,matchesOwnerScheduleDates,ownerScheduleWeek} from "@/lib/scheduling/whatIfOwnerDates";

type ReadSelector=InvestigationMemory["reads"][number];
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const day=z.string().date();
const periodSchema=z.strictObject({from:day,to:day});
type TemporalSelector={kind:"period";from:string;to:string}|{kind:"week";week:string;overrides:object[]};
/** Calendar selector shapes, not owner-question routing. Nested domain requests
 * cannot escape the same period guard used by top-level source contracts. */
function selector(input:unknown):TemporalSelector|null{
  if(!record(input))return null;
  if(record(input.period)){
    const p=periodSchema.safeParse(input.period);
    if(p.success)return {kind:"period",...p.data};
  }
  const request=record(input.request)?input.request:input;
  if(day.safeParse(request.week).success)return {kind:"week",week:request.week as string,
    overrides:Array.isArray(request.overrides)?request.overrides.filter(record):[]};
  return null;
}
function readSelector(read:ReadSelector):TemporalSelector|null{
  try{return selector(JSON.parse(read.inputJson));}catch{return null;}
}
// Calendar grammar reuses the canonical relative-date resolver; these are
// constraints on selectors, never mappings from owner questions to tools.
const relativePeriods:readonly [DateSelection["period"],RegExp][]=[
  ["month_to_date",/\bmonth[ -]to[ -]date\b|\bthis month\b|en lo que va del mes|este mes|منذ بداية الشهر|هذا الشهر/iu],
  ["previous_month",/\blast month\b|\bprevious month\b|mes pasado|الشهر الماضي/iu],
  ["week_to_date",/\bweek[ -]to[ -]date\b|en lo que va de la semana|منذ بداية الأسبوع/iu],
  ["previous_week",/\blast week\b|\bprevious week\b|semana pasada|الأسبوع الماضي/iu],
  ["last_7_days",/\blast (?:7|seven) days\b|(?:últimos|ultimos) (?:7|siete) días|آخر 7 أيام/iu],
  ["last_28_days",/\blast (?:28|twenty[ -]eight) days\b|(?:últimos|ultimos) 28 días|آخر 28 يوم/iu],
  ["yesterday",/\b(?:yesterday|ayer)\b|أمس/iu],
  ["today",/\b(?:today|hoy)\b|اليوم/iu],
];
function windows(text:string,asOf:string){
  const dates=parseOwnerDateWindows(text,asOf);
  if(dates.length)return dates;
  const relative=relativePeriods.filter(([,pattern])=>pattern.test(text));
  if(relative.length)return relative.map(([period])=>resolveCafeDateRange({period,from:null,to:null},asOf));
  const week=ownerScheduleWeek(text,asOf);
  return week?[{from:week,to:new Date(Date.parse(week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)}]:[];
}
/** Whether a same-thread owner statement could supply a corrected calendar
 * window. Reuse the exact validated relative/explicit date grammar that the
 * actual read selector guard uses; never classify owner business intent. */
export function hasInvestigationOwnerCalendarDate(text:string,asOf:string):boolean{
  return windows(text,asOf).length>0||hasOwnerScheduleDates(text,asOf);
}
/** Only an authenticated answer to an issued question for THIS registered
 * domain can replace the calendar guard's current date. Unrelated specialist
 * reads remain bound to the original request/remembered domain windows.
 * The original multi-goal owner text is not changed or shortened. */
export function authenticatedReadCalendarText(current:string,
  clarification:string|undefined,issuedCapabilityId:string|undefined,
  domain:string,asOf:string,domainForRead:(id:string)=>string|undefined):string{
  return clarification&&issuedCapabilityId&&
    domainForRead(issuedCapabilityId)===domain&&
    hasInvestigationOwnerCalendarDate(clarification,asOf)?clarification:current;
}

/** An authenticated correction may precede another question rather than a
 * reader dispatch. Capture only an unambiguous, parsed selector of the
 * previously issued domain; no financial observations or dates inferred by
 * the LLM are persisted. */
export function authenticatedOwnerCalendarScope(text:string,domain:string,
  asOf:string,kind:"period"|"week"):InvestigationCalendarScope|null{
  const ranges=windows(text,asOf);
  if(ranges.length!==1)return null;
  if(kind==="period")return {domain,kind,from:ranges[0].from,to:ranges[0].to};
  const week=ownerScheduleWeek(text,asOf);
  if(week)return {domain,kind,week};
  const days=Date.parse(ranges[0].to+"T12:00:00Z")-
    Date.parse(ranges[0].from+"T12:00:00Z");
  const monday=new Date(ranges[0].from+"T12:00:00Z").getUTCDay()===1;
  if(monday&&days===6*86400000)return {domain,kind,week:ranges[0].from};
  // A single explicit scheduling day is a valid correction to its containing
  // Monday-Sunday week. Only normalize an unambiguous single-day window.
  if(ranges[0].from!==ranges[0].to)return null;
  const date=new Date(ranges[0].from+"T12:00:00Z");
  date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
  return {domain,kind,week:date.toISOString().slice(0,10)};
}

export function investigationReadDatesMatch(input:unknown,current:string,asOf:string,
  memory:InvestigationMemory|undefined,_ownerStatements:readonly string[],domain:string,
  domainForRead:(capabilityId:string)=>string|undefined):boolean{
  const candidate=selector(input);
  if(!candidate)return true; // Inputs themselves still undergo registry schema validation.
  const hasDate=(s:string)=>windows(s,asOf).length>0||candidate.kind==="week"&&hasOwnerScheduleDates(s,asOf);
  const matches=(s:string)=>{
    if(candidate.kind==="period")return windows(s,asOf).some(w=>w.from===candidate.from&&w.to===candidate.to);
    if(hasOwnerScheduleDates(s,asOf))return matchesOwnerScheduleDates(candidate,s,asOf);
    const ranges=windows(s,asOf);
    const dates=candidate.overrides.flatMap(o=>"localDate" in o&&typeof o.localDate==="string"?[o.localDate]:[]);
    const end=new Date(Date.parse(candidate.week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10);
    return dates.length?dates.every(d=>d>=candidate.week&&d<=end&&ranges.some(w=>d>=w.from&&d<=w.to)):
      ranges.every(w=>w.from>=candidate.week&&w.to<=end);
  };
  if(hasDate(current))return matches(current);
  // A date belongs to its registered domain/read context. Scheduling turns
  // cannot change money periods. Attempted corrected reads persist their scope
  // even when source data is unavailable, so stale selectors cannot undo them.
  const scopes=(memory?.calendarScopes??[]).filter(s=>s.domain===domain&&s.kind===candidate.kind);
  const same=(s:TemporalSelector|InvestigationCalendarScope)=>s.kind==="week"&&candidate.kind==="week"?
    s.week===candidate.week:s.kind==="period"&&candidate.kind==="period"&&s.from===candidate.from&&s.to===candidate.to;
  if(scopes.length)return scopes.some(same);
  // Backward-compatible selector restoration, scoped by trusted registry owner.
  const remembered=(memory?.reads??[]).filter(r=>domainForRead(r.capabilityId)===domain)
    .map(readSelector).filter((s):s is TemporalSelector=>!!s&&s.kind===candidate.kind);
  if(remembered.length)return remembered.some(same);
  return true;
}
/** Preserve a period across intervening catalog reads. Once a turn successfully
 * reads a replacement calendar scope, older selectors of that shape expire. */
export function rememberInvestigationReads(previous:readonly ReadSelector[],current:readonly ReadSelector[]):ReadSelector[]{
  const replaced=new Set(current.map(readSelector).filter(s=>s!==null).map(s=>s.kind));
  const kept=previous.filter(r=>{const s=readSelector(r);return !s||!replaced.has(s.kind);});
  const unique=new Map<string,ReadSelector>();
  for(const read of [...kept,...current]){
    const key=JSON.stringify([read.capabilityId,read.inputJson]);unique.delete(key);unique.set(key,read);
  }
  const reads=[...unique.values()];
  // Calendar guards take priority over navigational catalog hints when bounded
  // memory fills; a full turn of catalog reads must not erase its date scope.
  return [...reads.filter(r=>!readSelector(r)),...reads.filter(r=>readSelector(r))].slice(-5);
}

/** Selectors only, never observations or model-granted domain identity. */
export function investigationCalendarScope(input:unknown,domain:string):InvestigationCalendarScope|null{
  const s=selector(input);
  return s?.kind==="period"?{domain,kind:s.kind,from:s.from,to:s.to}:
    s?.kind==="week"?{domain,kind:s.kind,week:s.week}:null;
}
export function rememberCalendarScopes(previous:readonly InvestigationCalendarScope[],current:readonly InvestigationCalendarScope[]):InvestigationCalendarScope[]{
  const replaced=new Set(current.map(s=>s.domain+":"+s.kind));
  const all=[...previous.filter(s=>!replaced.has(s.domain+":"+s.kind)),...current];
  return [...new Map(all.map(s=>[JSON.stringify(s),s])).values()].slice(-5);
}

/** Only owner turns newer than the last saved reply can be unbound corrections.
 * Their domain is checked semantically against trusted capability metadata;
 * dates themselves are still parsed from the exact owner-authored text. */
export function pendingOwnerCalendarCorrection(input:unknown,current:string,asOf:string,
  memory:InvestigationMemory|undefined,ownerStatements:readonly string[]):string|null{
  const candidate=selector(input);
  if(!candidate||!memory)return null;
  const hasDate=(s:string)=>windows(s,asOf).length>0||candidate.kind==="week"&&hasOwnerScheduleDates(s,asOf);
  if(hasDate(current))return null;
  const prior=ownerStatements.slice(0,-1),savedLast=memory.ownerStatements.at(-1);
  const savedIndex=savedLast?prior.lastIndexOf(savedLast):-1;
  if(savedIndex<0)return null;
  return prior.slice(savedIndex+1).reverse().find(hasDate)??null;
}
