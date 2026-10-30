import "server-only";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {nearbyEventsJsonSchema,nearbyEventsPrompt,parseNearbyEvents,responseOutputText,
  type NearbyEvent,type NearbyEventsSearch} from "./nearbyEvents";

/** One web search per café location and date window, through OpenAI's hosted
 * web_search tool (the same way ChatGPT answers "what's on near me"). It only
 * READS public pages: nothing is posted or sent anywhere. The location comes
 * from the café's saved profile or the owner's own answer, never from the model. */
const SEARCH_TIMEOUT_MS=25_000;
const CACHE_MS=3*60*60*1000;
const cache=new Map<string,{at:number;events:NearbyEvent[]}>();

type Fetch=typeof fetch;
export function createNearbyEventsSearch(deps:{fetch?:Fetch;now?:()=>number;apiKey?:string|undefined;model?:string}={}):NearbyEventsSearch{
  const doFetch=deps.fetch??fetch,now=deps.now??Date.now;
  return async input=>{
    const apiKey=deps.apiKey??process.env.OPENAI_API_KEY;
    if(!apiKey)return {available:false,reason:"notConfigured"};
    const key=[input.location,input.from,input.to].join("|").toLowerCase();
    const hit=cache.get(key);
    if(hit&&now()-hit.at<CACHE_MS)return {available:true,events:hit.events};
    const model=deps.model??(process.env.EVENTS_SEARCH_OPENAI_MODEL?.trim()||configuredSupervisorModel());
    const userLocation=input.city||input.countryCode?{type:"approximate",
      ...(input.city?{city:input.city}:{}),...(input.region?{region:input.region}:{}),
      ...(input.countryCode?{country:input.countryCode}:{})}:null;
    const call=async(tool:"web_search"|"web_search_preview",strictJson:boolean)=>{
      const signal=AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      const prompt=nearbyEventsPrompt(input.location,input.from,input.to);
      return doFetch("https://api.openai.com/v1/responses",{method:"POST",signal,
        headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
        body:JSON.stringify({model,max_output_tokens:1200,store:false,
          tools:[{type:tool,...(userLocation?{user_location:userLocation}:{})}],
          input:strictJson?prompt:prompt+" Answer with only this JSON and no other text: "+
            "{\"events\":[{\"name\":\"\",\"startDate\":\"YYYY-MM-DD\",\"endDate\":null,\"venue\":null,\"distance\":null,"+
            "\"kind\":\"other\",\"expectedCrowd\":\"unknown\",\"sourceUrl\":\"https://...\",\"sourceName\":null}]}",
          ...(strictJson?{text:{format:{type:"json_schema",name:"nearby_events",strict:true,schema:nearbyEventsJsonSchema}}}:{})})});
    };
    try{
      // A 400 means this model rejects the request shape: older snapshots only know
      // the preview tool name, and some cannot mix web search with strict JSON.
      let response=await call("web_search",true);
      if(response.status===400)response=await call("web_search_preview",true);
      if(response.status===400)response=await call("web_search",false);
      if(!response.ok){
        console.error("nearby_events_search_failed",{status:response.status}); // status only, never the address
        return {available:false,reason:"searchFailed"};
      }
      const text=responseOutputText(await response.json());
      const events=text===null?null:parseNearbyEvents(text,input.from,input.to);
      if(events===null){console.error("nearby_events_search_unparsed");return {available:false,reason:"searchFailed"};}
      if(cache.size>=200)cache.delete(cache.keys().next().value!);
      cache.set(key,{at:now(),events});
      return {available:true,events};
    }catch(error){
      const timeout=error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError");
      console.error("nearby_events_search_failed",{reason:timeout?"timeout":"network"});
      return {available:false,reason:timeout?"timeout":"searchFailed"};
    }
  };
}
export const searchNearbyEvents:NearbyEventsSearch=createNearbyEventsSearch();
/** Tests only. */
export function clearNearbyEventsCache(){cache.clear();}
