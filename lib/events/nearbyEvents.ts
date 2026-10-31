import {z} from "zod";

/** Local events near the café, found by a web search. Pure helpers: request
 * shape and strict parsing. The network call lives in nearbyEventsSearch.server.ts. */
export const EVENT_KINDS=["festival","conference","sports","concert","parade","market","holiday_event",
  "school","community","road_closure","public_holiday","other"] as const;
export const CROWD_SIZES=["small","medium","large","unknown"] as const;
export type NearbyEvent={name:string;startDate:string;endDate:string;venue:string|null;venueAddress?:string|null;
  startTime?:string|null;endTime?:string|null;distance:string|null;
  kind:typeof EVENT_KINDS[number];expectedCrowd:typeof CROWD_SIZES[number];sourceUrl:string;sourceName:string|null};
export type SearchFailureCategory="not_configured"|"http_error"|"incomplete"|"missing_message"|
  "empty_text"|"invalid_json"|"invalid_shape"|"invalid_response"|"timeout"|"network";
/** The public-event query that could not be completed, without exposing the café address. */
export type UnsearchedEventScope={kind:"general"}|{kind:"holiday";name:string;date:string};
/** Optional metadata keeps older search stubs compatible; the production search always sets it. */
export type NearbyEventsResult=
  |{available:true;outcome?:"found"|"none_found";events:NearbyEvent[];partial?:boolean;
      failedSearches?:UnsearchedEventScope[]}
  |{available:false;outcome?:"failed";reason:"notConfigured"|"searchFailed"|"timeout";
      category?:SearchFailureCategory};
export type NearbyEventsSearch=(input:{location:string;city:string|null;region:string|null;countryCode:string|null;
  from:string;to:string})=>Promise<NearbyEventsResult>;

export const MAX_EVENTS=8;
const nullableText=(max:number)=>z.union([z.string(),z.null()]).transform(v=>{
  const t=v?.replace(/\s+/gu," ").trim();return t?t.slice(0,max):null;});
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(d=>{
  const parsed=new Date(d+"T00:00:00Z");
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===d;
});
// Unknown optional dates/times may be null, missing or blank in plain fallback JSON.
const optionalDate=z.union([z.string(),z.null()]).optional()
  .transform(v=>v?.trim()||null).pipe(z.union([isoDate,z.null()]));
const optionalTime=z.union([z.string(),z.null()]).optional()
  .transform(v=>v?.trim()||null)
  .pipe(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).nullable());
const eventSchema=z.object({
  name:z.string().transform(v=>v.replace(/\s+/gu," ").trim().slice(0,90)).pipe(z.string().min(2)),
  startDate:isoDate,endDate:optionalDate,
  venue:nullableText(80).optional().transform(v=>v??null),venueAddress:nullableText(160).optional().transform(v=>v??null),
  startTime:optionalTime,endTime:optionalTime,
  distance:nullableText(40).optional().transform(v=>v??null),
  kind:z.enum(EVENT_KINDS).catch("other"),expectedCrowd:z.enum(CROWD_SIZES).catch("unknown"),
  sourceUrl:z.string().url().max(400).refine(u=>u.startsWith("https://")||u.startsWith("http://")),
  sourceName:nullableText(60).optional().transform(v=>v??null),
});

/** Strict JSON schema the search model must answer with (OpenAI strict mode). */
/** Restrict the web-search response to facts necessary to save an event.
 * Optional enrichment is a later concern; a 12-field strict schema repeatedly
 * yielded syntactically valid but unusable results in production. */
export const nearbyEventsJsonSchema={
  type:"object",additionalProperties:false,required:["events"],
  properties:{events:{type:"array",items:{type:"object",additionalProperties:false,
    required:["name","startDate","sourceUrl"],
    properties:{
      name:{type:"string",description:"Confirmed event name"},
      startDate:{type:"string",description:"Confirmed local YYYY-MM-DD date"},
      sourceUrl:{type:"string",description:"URL of page confirming this event on this date"},
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
    "Return only a compact JSON object with an events array. Each event has exactly "+
    "name, startDate (YYYY-MM-DD), and sourceUrl (the specific page confirming that date). "+
    "Do not return extra fields, commentary, markdown or citations outside the JSON. "+
    "Never guess or invent an event, date or URL; omit any event without a dated source page. "+
    "Return at most "+Math.min(MAX_EVENTS,5)+" confirmed events prioritizing likely local impact. "+
    "If none can be confirmed, return an events array with zero items.";
}

/** Accept a small, finite set of common, semantically identical JSON wrappers
 * returned by web_search. Never infer an event from arbitrary prose. */
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
const first=(row:Record<string,unknown>,keys:readonly string[]):unknown=>{
  for(const key of keys)if(row[key]!==undefined&&row[key]!==null&&row[key]!=="")return row[key];
  return null;
};
const eventList=(root:unknown):unknown[]|null=>{
  if(Array.isArray(root))return root;
  if(!record(root))return null;
  for(const key of ["events","results","items"]){
    if(Array.isArray(root[key]))return root[key] as unknown[];
  }
  for(const key of ["data","result","response"]){
    if(record(root[key])){
      const inner=root[key] as Record<string,unknown>;
      for(const listKey of ["events","results","items"])
        if(Array.isArray(inner[listKey]))return inner[listKey] as unknown[];
    }
    if(Array.isArray(root[key]))return root[key] as unknown[];
  }
  return null;
};
const verifiedSource=(row:Record<string,unknown>):unknown=>{
  const direct=first(row,["sourceUrl","source_url","url","link","eventUrl","event_url"]);
  if(typeof direct==="string"&&/^https?:\/\//iu.test(direct))return direct;
  for(const key of ["source","citation","citations","sources"]){
    const value=row[key];
    const candidates=Array.isArray(value)?value:[value];
    for(const item of candidates){
      if(typeof item==="string"&&/^https?:\/\//iu.test(item))return item;
      if(record(item)){
        const url=first(item,["url","sourceUrl","source_url","link"]);
        if(typeof url==="string"&&/^https?:\/\//iu.test(url))return url;
      }
    }
  }
  return null;
};
const monthNames=["january","february","march","april","may","june","july","august",
  "september","october","november","december"];
/** No locale-dependent Date.parse for ambiguous dates. Reject impossible days. */
const canonicalDate=(raw:unknown):unknown=>{
  if(typeof raw!=="string")return raw;
  const input=raw.trim();
  const iso=/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.exec(input);
  if(iso)return iso[1];
  const long=/^([A-Za-z]+) (\d{1,2}),? (\d{4})$/u.exec(input);
  if(!long)return raw;
  const month=monthNames.indexOf(long[1].toLowerCase())+1;
  if(!month)return raw;
  const formatted=long[3]+"-"+String(month).padStart(2,"0")+"-"+long[2].padStart(2,"0");
  const time=new Date(formatted+"T00:00:00Z");
  return !Number.isNaN(time.getTime())&&time.toISOString().slice(0,10)===formatted?formatted:raw;
};
const optionalClock=(raw:unknown):unknown=>typeof raw==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/u.test(raw)?raw:null;
const normalizedEvent=(row:Record<string,unknown>):Record<string,unknown>=>{
  const venue=first(row,["venue","locationName","location_name"]);
  const location=record(row.location)?row.location:null;
  const date=first(row,["startDate","start_date","date","date_start","eventDate","event_date"]);
  return {
    name:first(row,["name","title","eventName","event_name"]),
    startDate:canonicalDate(date),
    endDate:(()=>{
      const end=canonicalDate(first(row,["endDate","end_date"])??null);
      return typeof end==="string"&&isoDate.safeParse(end).success?end:null;
    })(),
    venue:typeof venue==="string"?venue:(record(venue)?first(venue,["name","title"]):null)??first(location??{},["name","venue"]),
    venueAddress:first(row,["venueAddress","venue_address","address"])??first(location??{},["address"]),
    startTime:optionalClock(first(row,["startTime","start_time"])),
    endTime:optionalClock(first(row,["endTime","end_time"])),
    distance:first(row,["distance"]),kind:first(row,["kind","type","category"]),
    expectedCrowd:first(row,["expectedCrowd","expected_crowd"]),
    sourceUrl:verifiedSource(row),sourceName:first(row,["sourceName","source_name"]),
  };
};
/** Privacy-safe reason codes. Do not log the actual event, source or location. */
export function diagnoseNearbyEventsShape(text:string,from:string,to:string):
  "missing_list"|"missing_source"|"invalid_date"|"outside_window"|"invalid_event"|"unrecognized"{
  let root:unknown;
  try{root=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu,""));}catch{return "unrecognized";}
  const list=eventList(root);
  if(!list)return "missing_list";
  if(list.length===0)return "unrecognized";
  let sources=0,dates=0,inWindow=0;
  for(const item of list){
    if(!record(item))continue;
    const e=normalizedEvent(item);
    if(e.sourceUrl)sources++;
    if(typeof e.startDate==="string"&&isoDate.safeParse(e.startDate).success){
      dates++;
      if(e.startDate>=from&&e.startDate<=to)inWindow++;
    }
  }
  if(!sources)return "missing_source";
  if(!dates)return "invalid_date";
  if(!inWindow)return "outside_window";
  return "invalid_event";
}
/** Keep sourced, dated events only. Invalid individual rows don't destroy valid ones. */
export function parseNearbyEvents(text:string,from:string,to:string):NearbyEvent[]|null{
  let raw:unknown;
  try{raw=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu,""));}catch{return null;}
  const list=eventList(raw);
  if(!list)return null;
  const seen=new Set<string>(),out:NearbyEvent[]=[];
  let inWindow=0;
  for(const item of list){
    const parsed=eventSchema.safeParse(record(item)?normalizedEvent(item):item);
    if(!parsed.success)continue;
    const e=parsed.data,end=e.endDate&&e.endDate>=e.startDate?e.endDate:e.startDate;
    if(end<from||e.startDate>to)continue;
    inWindow++;
    const key=e.name.toLowerCase()+"|"+e.startDate;
    if(seen.has(key))continue;
    seen.add(key);out.push({...e,endDate:end});
    if(out.length>=MAX_EVENTS)break;
  }
  // An unusable nonempty search is NOT proof that zero events exist.
  return list.length>0&&inWindow===0?null:out;
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
