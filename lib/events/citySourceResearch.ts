import {addDays} from "./holidays";
import type {EventScanWindow} from "./eventsLookahead";
import {nearbyEventsJsonSchema,parseNearbyEvents} from "./nearbyEvents";

/**
 * LDI B: read-only research contract for integration E.
 * This is NOT an event store, cron, reader, or impact assessment.
 * The OpenAI answer remains {events:[{name,startDate,sourceUrl}]}.
 */
export type CityEventCandidate={name:string;startDate:string;sourceUrl:string};
export type CitySourceKind="city_calendar"|"convention"|"university"|"festival"|
  "sports"|"arts"|"general"|"venue";
export type CityResearchSource={
  id:string;name:string;kind:CitySourceKind;
  /** When provided, candidates MUST link to this official host (or its subdomains). */
  officialUrl?:string;
};
export type CityResearchWindow=EventScanWindow;
export type CityResearchFailure="not_configured"|"http_error"|"incomplete"|"missing_message"|
  "invalid_json"|"invalid_shape"|"timeout"|"network"|"request_budget"|"invalid_scope";
export type CitySourceOutcome="found"|"none_found"|"partial"|"failed";
export type CitySourceCoverage={
  sourceId:string;sourceKind:CitySourceKind;officialUrl:string|null;
  from:string;to:string;reason:CityResearchWindow["reason"];
  checkedAt:string;outcome:CitySourceOutcome;
  /** Retry failures or incompletely covered windows; never advance a complete cursor for these. */
  retryEligible:boolean;failure:CityResearchFailure|null;
  events:CityEventCandidate[];
};
export type CitySourceResearchResult={
  events:CityEventCandidate[];sources:CitySourceCoverage[];
  duplicateCount:number;partial:boolean;retrySourceIds:string[];
};
export const cityResearchJsonSchema=nearbyEventsJsonSchema;
export const CITY_RESEARCH_MAX_OUTPUT_TOKENS=1200;
export const CITY_RESEARCH_PER_CALL_LIMIT=5;

/** Category probes are not an exhaustive registry. Integration E can add researched official venue URLs. */
export function defaultCityResearchSources():CityResearchSource[]{
  return [
    {id:"city-calendar",name:"municipal and tourism event calendars",kind:"city_calendar"},
    {id:"convention",name:"convention centers and conference calendars",kind:"convention"},
    {id:"campuses",name:"universities and campus public calendars",kind:"university"},
    {id:"festivals",name:"festival, market and parade organizers",kind:"festival"},
    {id:"sports",name:"professional and college sports venue schedules",kind:"sports"},
    {id:"arts",name:"concert halls, theaters and arenas",kind:"arts"},
    {id:"city-catchall",name:"other confirmed citywide public events and holidays",kind:"general"},
  ];
}
const iso=(date:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(date)&&
  !Number.isNaN(Date.parse(date+"T00:00:00Z"))&&
  new Date(date+"T00:00:00Z").toISOString().slice(0,10)===date;
export function cityResearchDateSlices(from:string,to:string):Array<{from:string;to:string}>{
  if(!iso(from)||!iso(to)||from>to||to>addDays(from,13))
    throw new Error("Invalid city research window (maximum 14 inclusive days)");
  const out:Array<{from:string;to:string}>=[];
  for(let start=from;start<=to;start=addDays(start,7))
    out.push({from:start,to:addDays(start,6)<to?addDays(start,6):to});
  return out;
}
function trustedUrl(raw:string):URL|null{
  try{
    const url=new URL(raw);
    return (url.protocol==="https:"||url.protocol==="http:")&&
      !url.username&&!url.password&&Boolean(url.hostname)?url:null;
  }catch{return null;}
}
function officialHost(url:URL,source:CityResearchSource):boolean{
  if(!source.officialUrl)return true;
  const official=trustedUrl(source.officialUrl);
  return !!official&&(url.hostname===official.hostname||
    url.hostname.endsWith("."+official.hostname));
}
/** Deterministic cross-source exact-name/date reconciliation, not a persisted ID. */
export function cityCandidateKey(event:CityEventCandidate):string{
  const name=event.name.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/gu," ");
  return name+"|"+event.startDate;
}
export function cityResearchPrompt(city:string,region:string|null,countryCode:string|null,
  source:CityResearchSource,from:string,to:string):string{
  const place=[city,region,countryCode].filter(Boolean).join(", ");
  return "Find confirmed public events in "+place+" from "+from+" to "+to+
    " (inclusive), focusing ONLY on "+source.name+"."+
    (source.officialUrl?" Search the official source "+source.officialUrl+
      " and its linked event pages; cite only pages on that official host. ":
      " Search official organizers, public venue calendars and original dated listings; avoid aggregators. ")+
    " For each event supply the specific source page that confirms its LOCAL date."+
    " Give exactly name, startDate (YYYY-MM-DD) and sourceUrl. "+
    "Return only compact JSON {events:[{name,startDate,sourceUrl}]} with at most "+
    CITY_RESEARCH_PER_CALL_LIMIT+" entries, or {events:[]} when nothing can be confirmed. "+
    "No venue guesses, crowd estimates, commentary, markdown, or unsupported dates/URLs. "+
    "An empty answer does not prove the whole city has no events.";
}
/** Track rejected individual listings; the shared parser intentionally skips bad rows. */
function responseRows(text:string):unknown[]|null{
  let root:unknown;
  try{root=JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gu,""));}catch{return null;}
  if(Array.isArray(root))return root;
  const pick=(value:unknown):unknown[]|null=>{
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const record=value as Record<string,unknown>;
    for(const key of ["events","results","items"])
      if(Array.isArray(record[key]))return record[key] as unknown[];
    return null;
  };
  const direct=pick(root);
  if(direct)return direct;
  if(root&&typeof root==="object")
    for(const key of ["data","result","response"]){
      const child=(root as Record<string,unknown>)[key];
      if(Array.isArray(child))return child;
      const nested=pick(child);
      if(nested)return nested;
    }
  return null;
}
export function parseCityResearchEvents(text:string,from:string,to:string,source:CityResearchSource):
  {events:CityEventCandidate[];saturated:boolean;filtered:boolean}|null{
  // Reuse the existing forgiving Responses parser; project back to the original THREE fields.
  const parsed=parseNearbyEvents(text,from,to);
  if(parsed===null)return null;
  const rows=responseRows(text);
  // Bad dates, unsupported sources and out-of-window rows cannot count as completed coverage.
  // Deduplicated valid rows do not count as missing evidence.
  const rejected=rows?.some(row=>parseNearbyEvents(JSON.stringify({events:[row]}),from,to)?.length!==1)??false;
  const events:CityEventCandidate[]=[];let filtered=rejected;
  const seen=new Set<string>();
  for(const item of parsed){
    const url=trustedUrl(item.sourceUrl);
    if(!url||!officialHost(url,source)){filtered=true;continue;}
    const candidate={name:item.name,startDate:item.startDate,sourceUrl:url.toString()};
    const key=cityCandidateKey(candidate)+"|"+candidate.sourceUrl;
    if(seen.has(key))continue;
    seen.add(key);
    events.push(candidate);
  }
  // A single compact answer is never treated as an unbounded event catalog.
  return {events:events.slice(0,CITY_RESEARCH_PER_CALL_LIMIT),
    saturated:Math.max(parsed.length,rows?.length??0)>=CITY_RESEARCH_PER_CALL_LIMIT,filtered};
}
