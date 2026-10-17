import {z} from "zod";
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
function windows(text:string,asOf:string){
  const dates=parseOwnerDateWindows(text,asOf);
  if(dates.length)return dates;
  const week=ownerScheduleWeek(text,asOf);
  return week?[{from:week,to:new Date(Date.parse(week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)}]:[];
}
export function investigationReadDatesMatch(input:unknown,current:string,asOf:string,
  memory:InvestigationMemory|undefined,ownerStatements:readonly string[]):boolean{
  const candidate=selector(input);
  if(!candidate)return true; // Inputs themselves still undergo registry schema validation.
  const hasDate=(s:string)=>candidate.kind==="week"?hasOwnerScheduleDates(s,asOf):windows(s,asOf).length>0;
  const matches=(s:string)=>candidate.kind==="week"?matchesOwnerScheduleDates(candidate,s,asOf):
    windows(s,asOf).some(w=>w.from===candidate.from&&w.to===candidate.to);
  if(hasDate(current))return matches(current);
  // New owner turns after the persisted reply may have failed before saving
  // memory. Their explicit replacement date still supersedes older selectors.
  const prior=ownerStatements.slice(0,-1);
  const savedLast=memory?.ownerStatements.at(-1);
  const savedIndex=savedLast?prior.lastIndexOf(savedLast):-1;
  const newer=savedIndex>=0?prior.slice(savedIndex+1):[];
  const replacement=[...newer].reverse().find(hasDate);
  if(replacement)return matches(replacement);
  const remembered=(memory?.reads??[]).map(readSelector).filter(s=>s?.kind===candidate.kind);
  if(remembered.length)return remembered.some(s=>s?.kind==="week"&&candidate.kind==="week"?
    s.week===candidate.week:s?.kind==="period"&&candidate.kind==="period"&&s.from===candidate.from&&s.to===candidate.to);
  const previous=[...prior].reverse().find(hasDate);
  return previous?matches(previous):true;
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
  return [...unique.values()].slice(-5);
}
