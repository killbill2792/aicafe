import {z} from "zod";

/** Local events near the café, found by a web search. Pure helpers: request
 * shape and strict parsing. The network call lives in nearbyEventsSearch.server.ts. */
export const EVENT_KINDS=["festival","conference","sports","concert","parade","market","holiday_event",
  "school","community","road_closure","public_holiday","other"] as const;
export const CROWD_SIZES=["small","medium","large","unknown"] as const;
export type NearbyEvent={name:string;startDate:string;endDate:string;venue:string|null;venueAddress:string|null;
  startTime:string|null;endTime:string|null;distance:string|null;
  kind:typeof EVENT_KINDS[number];expectedCrowd:typeof CROWD_SIZES[number];sourceUrl:string;sourceName:string|null};
export type SearchFailureCategory="not_configured"|"http_error"|"incomplete"|"missing_message"|
  "empty_text"|"invalid_json"|"invalid_shape"|"invalid_response"|"timeout"|"network";
export type NearbyEventsResult=
  |{available:true;outcome:"found";events:NearbyEvent[];partial:boolean}
  |{available:true;outcome:"none_found";events:NearbyEvent[];partial:false}
  |{available:false;outcome:"failed";reason:"notConfigured"|"searchFailed"|"timeout";category:SearchFailureCategory};
export type NearbyEventsSearch=(input:{location:string;city:string|null;region:string|null;countryCode:string|null;
  from:string;to:string})=>Promise<NearbyEventsResult>;

export const MAX_EVENTS=8;
const nullableText=(max:number)=>z.union([z.string(),z.null()]).transform(v=>{
  const t=v?.replace(/\s+/gu," ").trim();return t?t.slice(0,max):null;});
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(d=>!Number.isNaN(Date.parse(d+"T00:00:00Z")));
const eventSchema=z.object({
  name:z.string().transform(v=>v.replace(/\s+/gu," ").trim().slice(0,90)).pipe(z.string().min(2)),
  startDate:isoDate,endDate:z.union([isoDate,z.null()]),
  venue:nullableText(80),venueAddress:nullableText(160).optional().transform(v=>v??null),
  startTime:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/u).nullable().optional().transform(v=>v??null),
  endTime:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/u).nullable().optional().transform(v=>v??null),
  distance:nullableText(40),
  kind:z.enum(EVENT_KINDS).catch("other"),expectedCrowd:z.enum(CROWD_SIZES).catch("unknown"),
  sourceUrl:z.string().url().max(400).refine(u=>u.startsWith("https://")||u.startsWith("http://")),
  sourceName:nullableText(60),
});

/** Strict JSON schema the search model must answer with (OpenAI strict mode). */
export const nearbyEventsJsonSchema={
  type:"object",additionalProperties:false,required:["events"],
  properties:{events:{type:"array",items:{type:"object",additionalProperties:false,
    required:["name","startDate","endDate","venue","venueAddress","startTime","endTime","distance",
      "kind","expectedCrowd","sourceUrl","sourceName"],
    properties:{
      name:{type:"string"},startDate:{type:"string",description:"YYYY-MM-DD"},
      endDate:{type:["string","null"],description:"YYYY-MM-DD, null for one day"},
      venue:{type:["string","null"]},venueAddress:{type:["string","null"]},
      startTime:{type:["string","null"],description:"Local HH:MM, null if unconfirmed"},
      endTime:{type:["string","null"],description:"Local HH:MM, null if unconfirmed"},
      distance:{type:["string","null"],description:"Verified distance or area name, never a guessed number"},
      kind:{type:"string",enum:[...EVENT_KINDS]},expectedCrowd:{type:"string",enum:[...CROWD_SIZES]},
      sourceUrl:{type:"string",description:"The page that confirms the date"},sourceName:{type:["string","null"]},
    }}}},
} as const;

export function nearbyEventsPrompt(location:string,from:string,to:string,
  holiday?:{name:string;date:string}):string{
  const focus=holiday?"Search specifically for "+holiday.name+" events near "+location+" on "+holiday.date+
    ". Include only confirmed events for that holiday. ":"Search the web for public events happening near this café: "+
    location+". Dates: "+from+" to "+to+" (inclusive). ";
  return focus+
    "Include anything that could change how many people walk past or visit a café within about "+
    "2 miles / 3 km: festivals, conferences and conventions, tech or trade weeks, sports games, concerts, parades, "+
    "markets, holiday events (Halloween, trick-or-treat events, tree lightings), school or university events, "+
    "marathons and road closures. Also include public holidays in that country during those dates (kind public_holiday). "+
    "Only include events whose date in this window is confirmed by a page you found; give that page as sourceUrl. "+
    "Provide the venue address and local start/end times when a source confirms them; otherwise use null. "+
    "Never guess or invent an event, a date or a crowd size; use expectedCrowd unknown when not stated. "+
    "Up to "+MAX_EVENTS+" events, the ones most likely to affect a café first. If nothing is found, return an empty list.";
}

/** Keep only well-formed events inside [from, to], deduplicated, at most MAX_EVENTS. */
export function parseNearbyEvents(text:string,from:string,to:string):NearbyEvent[]|null{
  let raw:unknown;
  try{raw=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu,""));}catch{return null;}
  const list=raw&&typeof raw==="object"&&Array.isArray((raw as {events?:unknown}).events)?
    (raw as {events:unknown[]}).events:null;
  if(!list)return null;
  const seen=new Set<string>(),out:NearbyEvent[]=[];
  for(const item of list){
    const parsed=eventSchema.safeParse(item);
    if(!parsed.success)continue;
    const e=parsed.data,end=e.endDate&&e.endDate>=e.startDate?e.endDate:e.startDate;
    if(end<from||e.startDate>to)continue; // outside the asked window
    const key=e.name.toLowerCase()+"|"+e.startDate;
    if(seen.has(key))continue;
    seen.add(key);
    out.push({...e,endDate:end});
    if(out.length>=MAX_EVENTS)break;
  }
  return out;
}

/** The text answer of a Responses API result (raw HTTP shape). */
export function responseOutputText(body:unknown):string|null{
  const output=body&&typeof body==="object"?(body as {output?:unknown}).output:null;
  if(!Array.isArray(output))return null;
  const parts:string[]=[];
  for(const item of output){
    if(!item||typeof item!=="object"||(item as {type?:unknown}).type!=="message")continue;
    const content=(item as {content?:unknown}).content;
    if(!Array.isArray(content))continue;
    for(const c of content)if(c&&typeof c==="object"&&(c as {type?:unknown}).type==="output_text"&&
      typeof (c as {text?:unknown}).text==="string")parts.push((c as {text:string}).text);
  }
  return parts.length?parts.join(""):null;
}
