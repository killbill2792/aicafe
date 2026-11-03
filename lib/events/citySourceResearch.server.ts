import "server-only";
import {DEFAULT_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
import {responseOutputText} from "./nearbyEvents";
import {addDays} from "./holidays";
import {CITY_RESEARCH_MAX_OUTPUT_TOKENS,CITY_RESEARCH_PER_CALL_LIMIT,cityCandidateKey,
  cityResearchDateSlices,cityResearchJsonSchema,cityResearchPrompt,defaultCityResearchSources,
  parseCityResearchEvents,type CityResearchFailure,type CityResearchSource,
  type CityResearchWindow,type CitySourceCoverage,type CitySourceResearchResult,
  type CityEventCandidate} from "./citySourceResearch";

const MAX_SOURCES=8,MAX_SEARCHES=24,MAX_DEPTH=3,PARALLEL_SOURCES=3;
const FIRST_TIMEOUT_MS=12_000,RETRY_TIMEOUT_MS=8_000;
type RequestFetch=typeof fetch;
type SearchAttempt={ok:true;events:CityEventCandidate[];saturated:boolean;filtered:boolean}|
  {ok:false;failure:CityResearchFailure;status:number|null;retryEligible:boolean};
export type CitySourceResearchInput={
  city:string;region:string|null;countryCode:string|null;window:CityResearchWindow;
  /** Official venue/calendar sources from saved public evidence, or category defaults. */
  sources?:CityResearchSource[];
};
export type CitySourceResearch=(input:CitySourceResearchInput)=>Promise<CitySourceResearchResult>;

function canRetryHttp(status:number):boolean{
  return status===408||status===429||status>=500;
}
function invalidOfficialUrl(source:CityResearchSource):boolean{
  if(!source.officialUrl)return false;
  try{
    const url=new URL(source.officialUrl);
    return url.protocol!=="https:"&&url.protocol!=="http:"||
      Boolean(url.username||url.password||url.hash)||!url.hostname;
  }catch{return true;}
}
function sourceValid(source:CityResearchSource):boolean{
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source.id)&&
    source.name.trim().length>0&&source.name.length<=120&&
    !invalidOfficialUrl(source);
}

/**
 * Purely on-demand adapter. E invokes this inside the one existing lookahead cron,
 * persists only through A's writer and retries incomplete source/window coverage.
 * No cache: incomplete coverage must never become a falsely complete scan.
 */
export function createCitySourceResearch(deps:{
  fetch?:RequestFetch;apiKey?:string;model?:string;now?:()=>Date;maxSearches?:number;
}={}):CitySourceResearch{
  const doFetch=deps.fetch??fetch;
  const now=deps.now??(()=>new Date());
  const maxSearches=Math.min(MAX_SEARCHES,Math.max(1,Math.floor(deps.maxSearches??MAX_SEARCHES)));
  return async input=>{
    const slices=cityResearchDateSlices(input.window.from,input.window.to);
    const city=input.city.trim();
    if(!city||city.length>120)throw new Error("City research requires a canonical city");
    const sources=input.sources??defaultCityResearchSources();
    if(!sources.length)throw new Error("City research requires at least one source");
    const usedIds=new Set<string>();
    if(sources.some(s=>{const duplicate=usedIds.has(s.id);usedIds.add(s.id);return duplicate;}))
      throw new Error("Duplicate city research source ID");
    const coverage:CitySourceCoverage[]=[];
    const apiKey=deps.apiKey??process.env.OPENAI_API_KEY;
    const model=deps.model??(process.env.EVENTS_SEARCH_OPENAI_MODEL?.trim()||
      DEFAULT_SUPERVISOR_OPENAI_MODEL);
    const userLocation=input.city?{type:"approximate",city,
      ...(input.region?{region:input.region}:{}),
      ...(input.countryCode?{country:input.countryCode}:{})}:null;
    let searches=0;
    const stamped=(source:CityResearchSource,from:string,to:string,
      outcome:CitySourceCoverage["outcome"],events:CityEventCandidate[],
      failure:CityResearchFailure|null,retryEligible:boolean):CitySourceCoverage=>({
      sourceId:source.id,sourceKind:source.kind,officialUrl:source.officialUrl??null,
      from,to,reason:input.window.reason,checkedAt:now().toISOString(),
      outcome,events,failure,retryEligible,
    });

    const attempt=async(source:CityResearchSource,from:string,to:string,
      mode:"schema"|"preview"|"plain",number:number):Promise<SearchAttempt>=>{
      // The budget counts provider HTTP attempts, not just logical source queries.
      if(searches>=maxSearches)
        return {ok:false,failure:"request_budget",status:null,retryEligible:true};
      searches++;
      let status:number|null=null;
      try{
        const strict=mode!=="plain";
        const response=await doFetch("https://api.openai.com/v1/responses",{
          method:"POST",headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
          signal:AbortSignal.timeout(number===1?FIRST_TIMEOUT_MS:RETRY_TIMEOUT_MS),
          body:JSON.stringify({
            model:strict?model:DEFAULT_SUPERVISOR_OPENAI_MODEL,
            store:false,max_output_tokens:CITY_RESEARCH_MAX_OUTPUT_TOKENS,
            tools:[{type:mode==="preview"?"web_search_preview":"web_search",
              ...(userLocation?{user_location:userLocation}:{})}],
            input:cityResearchPrompt(city,input.region,input.countryCode,source,from,to),
            ...(strict?{text:{format:{type:"json_schema",name:"nearby_events",
              strict:true,schema:cityResearchJsonSchema}}}:{})
          }),
        });
        status=response.status;
        if(!response.ok)
          return {ok:false,failure:"http_error",status,retryEligible:canRetryHttp(status)};
        let data:unknown;
        try{data=await response.json();}catch{
          return {ok:false,failure:"invalid_json",status,retryEligible:true};
        }
        const body=data&&typeof data==="object"?data as {
          status?:unknown;output?:unknown;incomplete_details?:unknown}:null;
        if(body?.status==="incomplete")
          return {ok:false,failure:"incomplete",status,retryEligible:true};
        if(body?.status==="failed"||body?.status==="in_progress")
          return {ok:false,failure:"invalid_shape",status,retryEligible:true};
        // A model can emit valid JSON without using the web tool. Such a response
        // is NOT evidence that its official source/calendar was actually checked.
        const searchCalls=Array.isArray(body?.output)?body.output.filter(item=>
          item&&typeof item==="object"&&
          (item as {type?:unknown}).type==="web_search_call") as Array<{status?:unknown}>:[];
        if(!searchCalls.length||searchCalls.some(call=>call.status!=="completed"))
          return {ok:false,failure:"invalid_shape",status,retryEligible:true};
        const output=responseOutputText(data);
        if(!output?.trim())
          return {ok:false,failure:"missing_message",status,retryEligible:true};
        const parsed=parseCityResearchEvents(output,from,to,source);
        if(!parsed){
          let isJson=false;
          try{JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gu,""));isJson=true;}catch{}
          return {ok:false,failure:isJson?"invalid_shape":"invalid_json",status,retryEligible:true};
        }
        return {ok:true,...parsed};
      }catch(error){
        const timeout=error instanceof Error&&
          (error.name==="TimeoutError"||error.name==="AbortError");
        return {ok:false,failure:timeout?"timeout":"network",status,retryEligible:true};
      }
    };
    const request=async(source:CityResearchSource,from:string,to:string):Promise<SearchAttempt>=>{
      const first=await attempt(source,from,to,"schema",1);
      if(first.ok)return first;
      if(first.status===400){
        const preview=await attempt(source,from,to,"preview",2);
        if(preview.ok||preview.status!==400)return preview;
        return attempt(source,from,to,"plain",3);
      }
      // A 200-incomplete/reasoning-only/malformed body is not an empty result.
      if(first.status===200||first.retryEligible)
        return attempt(source,from,to,"plain",2);
      return first;
    };

    const work=async(source:CityResearchSource,from:string,to:string,
      depth:number):Promise<CitySourceCoverage[]>=>{
      if(!sourceValid(source))return [stamped(source,from,to,"failed",[],
        "invalid_scope",false)];
      if(!apiKey)return [stamped(source,from,to,"failed",[],"not_configured",false)];
      if(searches>=maxSearches)return [stamped(source,from,to,"failed",[],
        "request_budget",true)];
      const result=await request(source,from,to);
      if(!result.ok)return [stamped(source,from,to,"failed",[],
        result.failure,result.retryEligible)];
      if(result.saturated&&from<to&&depth<MAX_DEPTH&&searches+2<=maxSearches){
        const days=Math.floor((Date.parse(to+"T00:00:00Z")-
          Date.parse(from+"T00:00:00Z"))/86_400_000);
        const mid=addDays(from,Math.floor(days/2));
        const left=await work(source,from,mid,depth+1);
        const right=await work(source,addDays(mid,1),to,depth+1);
        // Keep parent facts if narrower searches happen to miss a listing.
        const childKeys=new Set([...left,...right].flatMap(c=>c.events.map(cityCandidateKey)));
        const missing=result.events.filter(e=>!childKeys.has(cityCandidateKey(e)));
        // Do not relabel an unresolved parent event with the wrong child window.
        // Preserve its fact, but make the unresolved source/date scope retryable.
        return [...left,...right,...(missing.length?[stamped(source,from,to,
          "partial",missing,"invalid_shape",true)]:[])];
      }
      const incomplete=result.filtered||result.saturated;
      return [stamped(source,from,to,incomplete?"partial":
        result.events.length?"found":"none_found",result.events,
        incomplete?"invalid_shape":null,incomplete)];
    };

    // A bounded pool avoids N simultaneous web searches and a per-café request explosion.
    const picked=sources.slice(0,MAX_SOURCES);
    const grouped:CitySourceCoverage[][]=Array.from({length:picked.length},()=>[]);
    let next=0;
    await Promise.all(Array.from({length:Math.min(PARALLEL_SOURCES,picked.length)},async()=>{
      while(next<picked.length){
        const i=next++;
        const source=picked[i];
        for(const slice of slices)
          grouped[i].push(...await work(source,slice.from,slice.to,0));
      }
    }));
    for(const group of grouped)coverage.push(...group);
    for(const source of sources.slice(MAX_SOURCES))
      coverage.push(stamped(source,input.window.from,input.window.to,
        "failed",[],"request_budget",true));

    const events:CityEventCandidate[]=[],seen=new Set<string>();
    let duplicateCount=0;
    for(const scoped of coverage)for(const event of scoped.events){
      const key=cityCandidateKey(event);
      if(seen.has(key)){duplicateCount++;continue;}
      seen.add(key);events.push(event);
    }
    events.sort((a,b)=>a.startDate.localeCompare(b.startDate)||a.name.localeCompare(b.name));
    const retrySourceIds=[...new Set(coverage.filter(s=>s.retryEligible).map(s=>s.sourceId))];
    return {events,sources:coverage,duplicateCount,partial:coverage.some(s=>
      s.outcome==="failed"||s.outcome==="partial"),retrySourceIds};
  };
}
export const researchCitySources:CitySourceResearch=createCitySourceResearch();
