import "server-only";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {holidaysBetween} from "./holidays";
import {MAX_EVENTS,nearbyEventsJsonSchema,nearbyEventsPrompt,parseNearbyEvents,responseOutputText,
  type NearbyEvent,type NearbyEventsSearch,type SearchFailureCategory} from "./nearbyEvents";

/** Web search is read-only. Addresses and fetched page text must never be logged. */
export const SEARCH_MAX_OUTPUT_TOKENS=4000; // Proposal D4: 1200 starved reasoning + web-search output; verify in test café.
const SEARCH_TIMEOUT_MS=25_000;
const CACHE_MS=3*60*60*1000;
const cache=new Map<string,{at:number;events:NearbyEvent[];partial:boolean}>();

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
      {available:true,outcome:"found",events:hit.events,partial:hit.partial}:
      {available:true,outcome:"none_found",events:[],partial:false};

    const model=deps.model??(process.env.EVENTS_SEARCH_OPENAI_MODEL?.trim()||configuredSupervisorModel());
    const userLocation=input.city||input.countryCode?{type:"approximate",
      ...(input.city?{city:input.city}:{}),...(input.region?{region:input.region}:{}),
      ...(input.countryCode?{country:input.countryCode}:{})}:null;

    const attempt=async(prompt:string,tool:"web_search"|"web_search_preview",
      strictJson:boolean,number:number,kind:"general"|"holiday"):Promise<Attempt>=>{
      const start=now();
      let httpStatus:number|null=null,status:string|null=null,incompleteReason:string|null=null;
      let outputTypes:string[]=[];
      let failure:SearchFailureCategory|null=null;
      try{
        const response=await doFetch("https://api.openai.com/v1/responses",{
          method:"POST",signal:AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
          body:JSON.stringify({model,max_output_tokens:SEARCH_MAX_OUTPUT_TOKENS,store:false,
            tools:[{type:tool,...(userLocation?{user_location:userLocation}:{})}],
            input:strictJson?prompt:prompt+" Respond with only a JSON object containing an events array, "+
              "with name, startDate, endDate, venue, venueAddress, startTime, endTime, distance, "+
              "kind, expectedCrowd, sourceUrl and sourceName for each event. Use null for unknown fields.",
            ...(strictJson?{text:{format:{type:"json_schema",name:"nearby_events",strict:true,
              schema:nearbyEventsJsonSchema}}}:{})})});
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
            else{
              const text=responseOutputText(body);
              if(text===null)failure="missing_message";
              else if(!text.trim())failure="empty_text";
              else{
                const events=parseNearbyEvents(text,input.from,input.to);
                if(events!==null)return {ok:true,events};
                try{JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gu,""));}
                catch{failure="invalid_json";}
                if(!failure)failure="invalid_shape";
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
          format:strictJson?"schema":"plain",tool,status,httpStatus,incompleteReason,
          outputTypes,parseFailure:failure,durationMs:Math.max(0,now()-start)});
      }
      return {ok:false,category:failure??"invalid_response",
        reason:failure==="timeout"?"timeout":"searchFailed",...(httpStatus!==null?{httpStatus}:{})};
    };

    const oneQuery=async(prompt:string,kind:"general"|"holiday"):Promise<Attempt>=>{
      const first=await attempt(prompt,"web_search",true,1,kind);
      if(first.ok)return first;
      if(first.httpStatus===400){
        const preview=await attempt(prompt,"web_search_preview",true,2,kind);
        if(preview.ok||preview.httpStatus!==400)return preview;
        return attempt(prompt,"web_search",false,3,kind);
      }
      // HTTP 200 can contain incomplete, reasoning-only, prose or no output.
      if(first.httpStatus===200)return attempt(prompt,"web_search",false,2,kind);
      return first;
    };

    let holidays:ReturnType<typeof holidaysBetween>=[];
    if(input.countryCode){
      try{holidays=holidaysBetween(input.from,input.to,input.countryCode,input.region,"en");}
      catch{holidays=holidaysBetween(input.from,input.to,input.countryCode,null,"en");}
    }
    const queries:[string,"general"|"holiday"][]=[
      [nearbyEventsPrompt(input.location,input.from,input.to),"general"],
      ...holidays.map(h=>[nearbyEventsPrompt(input.location,input.from,input.to,
        {name:h.name,date:h.date}),"holiday"] as [string,"holiday"]),
    ];
    // Independent requests overlap, so a holiday doesn't add its latency to the general search.
    const results=await Promise.all(queries.map(([prompt,kind])=>oneQuery(prompt,kind)));
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
    if(found.length){
      const partial=errors.length>0;
      if(cache.size>=200)cache.delete(cache.keys().next().value!);
      cache.set(key,{at:now(),events:found,partial});
      return {available:true,outcome:"found",events:found,partial};
    }
    if(errors.length){
      const error=errors.find(e=>e.category==="timeout")??errors[0];
      console.error("nearby_events_search_failed",{category:error.category,failedQueries:errors.length,
        totalQueries:queries.length});
      return {available:false,outcome:"failed",reason:error.reason,category:error.category};
    }
    if(cache.size>=200)cache.delete(cache.keys().next().value!);
    cache.set(key,{at:now(),events:[],partial:false});
    return {available:true,outcome:"none_found",events:[],partial:false};
  };
}
export const searchNearbyEvents:NearbyEventsSearch=createNearbyEventsSearch();
/** Tests only. */
export function clearNearbyEventsCache(){cache.clear();}
