import {z} from "zod";
import {resolveCafeDateRange,type DateSelection} from "@/lib/ai/conversations/dateRange";
import {parseOwnerDateWindows} from "@/lib/ai/conversations/ownerDateIntent";
import type {InvestigationMemory} from "@/lib/ai/conversations/investigationMemory";
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
export function investigationReadDatesMatch(input:unknown,current:string,asOf:string,
  memory:InvestigationMemory|undefined,ownerStatements:readonly string[]):boolean{
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
  // Explicit owner corrections remain authoritative even if the corrected
  // source read failed and the persisted selectors still describe the old scope.
  const prior=ownerStatements.slice(0,-1);
  const previous=[...prior].reverse().find(hasDate);
  if(previous)return matches(previous);
  const remembered=(memory?.reads??[]).map(readSelector).filter(s=>s?.kind===candidate.kind);
  if(remembered.length)return remembered.some(s=>s?.kind==="week"&&candidate.kind==="week"?
    s.week===candidate.week:s?.kind==="period"&&candidate.kind==="period"&&s.from===candidate.from&&s.to===candidate.to);
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
