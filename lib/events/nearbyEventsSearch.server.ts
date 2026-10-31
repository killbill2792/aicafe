import "server-only";
import {DEFAULT_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
import {holidaysBetween} from "./holidays";
import {MAX_EVENTS,nearbyEventsJsonSchema,nearbyEventsMinimalJsonSchema,nearbyEventsMinimalPrompt,
  nearbyEventsPrompt,nearbyEventsShapeProblem,parseNearbyEvents,responseOutputText,
  type NearbyEvent,type NearbyEventsSearch,type SearchFailureCategory,type UnsearchedEventScope} from "./nearbyEvents";

/** Web search is read-only. Addresses and fetched page text must never be logged. */
export const SEARCH_MAX_OUTPUT_TOKENS=1200; // AGENTS.md per-call cap; D4 increase awaits explicit approval.
const SEARCH_TIMEOUT_MS=25_000;
// A retry must not double the original 25-second deadline for every query.
const SEARCH_RETRY_TIMEOUT_MS=12_000;
const CACHE_MS=3*60*60*1000;
const cache=new Map<string,{at:number;events:NearbyEvent[];failedSearches:UnsearchedEventScope[]}>();

type Fetch=typeof fetch;
type Failure={category:SearchFailureCategory;reason:"searchFailed"|"timeout";httpStatus?:number};
type Attempt={events:NearbyEvent[];ok:true}|({ok:false}&Failure);
const safeValue=(value:unknown,allowed:readonly string[]):string|null=>
  typeof value==="string"?(allowed.includes(value)?value:"other"):null;
const incompleteReasons=["max_output_tokens","content_filter"] as const;
const outputKinds=["message","reasoning","web_search_call"] as const;

/** A failed search is not the same as an empty, successfully searched list. */
export function createNearbyEventsSearch(deps:{fetch?:Fetch;now?:()=>number;apiKey?:string|undefined;model?:string}={}):NearbyEventsSearch{
  const doFetch=deps.fetch??fetch,now=deps.now??Date.now;
  return async input=>{
    const apiKey=deps.apiKey??process.env.OPENAI_API_KEY;
    if(!apiKey)return {available:false,outcome:"failed",reason:"notConfigured",category:"not_configured"};
    const key=[input.location,input.city,input.region,input.countryCode,input.from,input.to].join("|").toLowerCase();
    const hit=cache.get(key);
    if(hit&&now()-hit.at<CACHE_MS)return hit.events.length?
      {available:true,outcome:"found",events:hit.events,partial:hit.failedSearches.length>0,
        failedSearches:hit.failedSearches}:
      {available:true,outcome:"none_found",events:[],partial:false};

    // The Supervisor may use a reasoning model. Search needs a compact answer within
    // the immutable 1,200-token limit, so its default is a non-reasoning model.
    const model=deps.model??(process.env.EVENTS_SEARCH_OPENAI_MODEL?.trim()||
      DEFAULT_SUPERVISOR_OPENAI_MODEL);
    const userLocation=input.city||input.countryCode?{type:"approximate",
      ...(input.city?{city:input.city}:{}),...(input.region?{region:input.region}:{}),
      ...(input.countryCode?{country:input.countryCode}:{})}:null;

    const attempt=async(prompt:string,tool:"web_search"|"web_search_preview",
      format:"schema"|"plain"|"minimal",number:number,kind:"general"|"holiday",requestModel=model):Promise<Attempt>=>{
      const start=now();
      let httpStatus:number|null=null,status:string|null=null,incompleteReason:string|null=null;
      let outputTypes:string[]=[];
      let failure:SearchFailureCategory|null=null,shapeFailure:string|null=null;
      try{
        const response=await doFetch("https://api.openai.com/v1/responses",{
          method:"POST",signal:AbortSignal.timeout(number===1?SEARCH_TIMEOUT_MS:SEARCH_RETRY_TIMEOUT_MS),
          headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
          body:JSON.stringify({model:requestModel,max_output_tokens:SEARCH_MAX_OUTPUT_TOKENS,store:false,
            tools:[{type:tool,...(userLocation?{user_location:userLocation}:{})}],
            input:format==="plain"?prompt+" Respond with only a JSON object containing an events array, "+
              "with name, startDate, endDate, venue, venueAddress, startTime, endTime, distance, "+
              "kind, expectedCrowd, sourceUrl and sourceName for each event. Use null for unknown fields.":prompt,
            ...(format!=="plain"?{text:{format:{type:"json_schema",
              name:format==="minimal"?"nearby_events_minimal":"nearby_events",strict:true,
              schema:format==="minimal"?nearbyEventsMinimalJsonSchema:nearbyEventsJsonSchema}}}:{})})});
        httpStatus=response.status;
        if(!response.ok)failure="http_error";
        else {
          let body:unknown;
          try{body=await response.json();}catch{failure="invalid_response";}
          if(!failure){
            const b=body&&typeof body==="object"?body as {
              status?:unknown;incomplete_details?:{reason?:unknown};output?:unknown}:null;
            status=safeValue(b?.status,["completed","incomplete","failed","in_progress"]);
            incompleteReason=safeValue(b?.incomplete_details?.reason,incompleteReasons);
            outputTypes=Array.isArray(b?.output)?b.output.slice(0,12).map((v:unknown)=>
              safeValue(v&&typeof v==="object"?(v as {type?:unknown}).type:undefined,outputKinds)??"other"):[];
            if(b?.status==="incomplete")failure="incomplete";
            else if(b?.status==="failed"||b?.status==="in_progress")failure="invalid_response";
            else{
              const text=responseOutputText(body);
              if(text===null)failure="missing_message";
              else if(!text.trim())failure="empty_text";
              else{
                const events=parseNearbyEvents(text,input.from,input.to);
                if(events!==null)return {ok:true,events};
                try{JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gu,""));}
                catch{failure="invalid_json";}
                if(!failure){
                  failure="invalid_shape";
                  shapeFailure=nearbyEventsShapeProblem(text,input.from,input.to);
                }
              }
            }
          }
        }
      }catch(error){
        failure=error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError")?
          "timeout":"network";
      }finally{
        // One privacy-safe record per attempt, whether it succeeded, failed, or timed out.
        console.info("nearby_events_search_attempt",{queryKind:kind,attempt:number,
          format,tool,status,httpStatus,incompleteReason,
          outputTypes,parseFailure:failure,shapeFailure,durationMs:Math.max(0,now()-start)});
      }
      return {ok:false,category:failure??"invalid_response",
        reason:failure==="timeout"?"timeout":"searchFailed",...(httpStatus!==null?{httpStatus}:{})};
    };

    const oneQuery=async(prompt:string,minimalPrompt:string,kind:"general"|"holiday"):Promise<Attempt>=>{
      const first=await attempt(prompt,"web_search","schema",1,kind);
      if(first.ok)return first;
      if(first.httpStatus===400){
        const preview=await attempt(prompt,"web_search_preview","schema",2,kind);
        if(preview.ok||preview.httpStatus!==400)return preview;
        return attempt(prompt,"web_search","plain",3,kind,DEFAULT_SUPERVISOR_OPENAI_MODEL);
      }
      // A well-formed JSON message with unusable event fields needs a simpler
      // CONTRACT, not the same 12-field request again with schema removed.
      // This bounded, three-field structured retry still requires date + source proof.
      if(first.httpStatus===200&&first.category==="invalid_shape")
        return attempt(minimalPrompt,"web_search","minimal",2,kind,
          DEFAULT_SUPERVISOR_OPENAI_MODEL);
      // Incomplete, missing or non-JSON replies still get one plain fallback.
      if(first.httpStatus===200)return attempt(prompt,"web_search","plain",2,kind,
        DEFAULT_SUPERVISOR_OPENAI_MODEL);
      // Retry a transient timeout/network error or HTTP 408, 429 or 5xx exactly once.
      // Authentication and other client errors must not trigger paid retries.
      if(first.category==="timeout"||first.category==="network"||first.httpStatus===408||
        first.httpStatus===429||(first.httpStatus!==undefined&&first.httpStatus>=500))
        return attempt(prompt,"web_search","plain",2,kind,DEFAULT_SUPERVISOR_OPENAI_MODEL);
      return first;
    };

    let holidays:ReturnType<typeof holidaysBetween>=[];
    if(input.countryCode){
      try{holidays=holidaysBetween(input.from,input.to,input.countryCode,input.region,"en");}
      catch{holidays=holidaysBetween(input.from,input.to,input.countryCode,null,"en");}
    }
    const queries:Array<{prompt:string;minimalPrompt:string;scope:UnsearchedEventScope}>=[
      {prompt:nearbyEventsPrompt(input.location,input.from,input.to),
        minimalPrompt:nearbyEventsMinimalPrompt(input.location,input.from,input.to),
        scope:{kind:"general"}},
      ...holidays.map(h=>({prompt:nearbyEventsPrompt(input.location,input.from,input.to,
        {name:h.name,date:h.date}),
        minimalPrompt:nearbyEventsMinimalPrompt(input.location,input.from,input.to,
        {name:h.name,date:h.date}),
        scope:{kind:"holiday" as const,name:h.name,date:h.date}})),
    ];
    // Independent requests overlap, so a holiday doesn't add its latency to the general search.
    const results=await Promise.all(queries.map(({prompt,minimalPrompt,scope})=>
      oneQuery(prompt,minimalPrompt,scope.kind)));
    const found:NearbyEvent[]=[],seen=new Set<string>();
    for(const result of results){
      if(!result.ok)continue;
      for(const event of result.events){
        const key=event.name.toLowerCase()+"|"+event.startDate;
        if(seen.has(key))continue;
        seen.add(key);found.push(event);
        if(found.length>=MAX_EVENTS)break;
      }
      if(found.length>=MAX_EVENTS)break;
    }
    const errors=results.filter((r):r is Attempt&Failure=>!r.ok);
    const failedSearches=queries.filter((_,i)=>!results[i].ok).map(q=>q.scope);
    if(found.length){
      // Partial evidence remains usable, but never cache it as completed coverage:
      // the next cron must get a chance to retry failed query scopes.
      if(!failedSearches.length){
        if(cache.size>=200)cache.delete(cache.keys().next().value!);
        cache.set(key,{at:now(),events:found,failedSearches:[]});
      }
      return {available:true,outcome:"found",events:found,
        partial:failedSearches.length>0,failedSearches};
    }
    if(errors.length){
      const error=errors.find(e=>e.category==="timeout")??errors[0];
      console.error("nearby_events_search_failed",{category:error.category,failedQueries:errors.length,
        totalQueries:queries.length});
      return {available:false,outcome:"failed",reason:error.reason,category:error.category};
    }
    if(cache.size>=200)cache.delete(cache.keys().next().value!);
    cache.set(key,{at:now(),events:[],failedSearches:[]});
    return {available:true,outcome:"none_found",events:[],partial:false};
  };
}
export const searchNearbyEvents:NearbyEventsSearch=createNearbyEventsSearch();
/** Tests only. */
export function clearNearbyEventsCache(){cache.clear();}
