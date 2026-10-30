import "server-only";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";

/** Read-only public web lookup for the authenticated Supervisor chat. */
export type WebSearchResult =
  | {available:true;answer:string;sources:Array<{title:string;url:string}>}
  | {available:false;reason:"notConfigured"|"timeout"|"providerFailed"|"unreadable"|"budget"};

export type WebSearchUsage={inputTokens:number;cachedTokens:number;outputTokens:number};
/** The outer agent reserves a model call before the request and records token usage. */
export type WebSearchBudget={
  reserveModelCall:()=>boolean;
  recordUsage:(usage:WebSearchUsage)=>void;
};
function tokens(value:unknown):number{
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:0;
}
export function webSearchUsage(body:unknown):WebSearchUsage{
  const row=body&&typeof body==="object"?body as {usage?:unknown}:null;
  const usage=row?.usage&&typeof row.usage==="object"?row.usage as {
    input_tokens?:unknown;output_tokens?:unknown;input_tokens_details?:{cached_tokens?:unknown};
  }:null;
  return {inputTokens:tokens(usage?.input_tokens),outputTokens:tokens(usage?.output_tokens),
    cachedTokens:tokens(usage?.input_tokens_details?.cached_tokens)};
}

const WEB_SEARCH_TIMEOUT_MS=20_000;
const WEB_SEARCH_OUTPUT_TOKENS=1200;
type Fetch=typeof fetch;

function publicSource(value:unknown):{title:string;url:string}|null{
  if(!value||typeof value!=="object")return null;
  const row=value as {url?:unknown;title?:unknown};
  if(typeof row.url!=="string"||row.url.length>500)return null;
  try{
    const url=new URL(row.url);
    if(url.protocol!=="https:"||url.username||url.password||url.hostname.length===0)return null;
    return {title:typeof row.title==="string"?row.title.trim().slice(0,100):url.hostname,url:url.href};
  }catch{return null;}
}

/** Responses API web_search returns web_search_call and message items, not a search-result array. */
export function extractWebSearchAnswer(body:unknown):{answer:string;sources:Array<{title:string;url:string}>}|null{
  if(!body||typeof body!=="object")return null;
  const response=body as {status?:unknown;output?:unknown};
  if(typeof response.status==="string"&&response.status!=="completed")return null;
  if(!Array.isArray(response.output))return null;
  const paragraphs:string[]=[],sources:Array<{title:string;url:string}>=[];
  const urls=new Set<string>();
  for(const item of response.output){
    if(!item||typeof item!=="object"||(item as {type?:unknown}).type!=="message")continue;
    const content=(item as {content?:unknown}).content;
    if(!Array.isArray(content))continue;
    for(const part of content){
      if(!part||typeof part!=="object"||(part as {type?:unknown}).type!=="output_text")continue;
      const text=(part as {text?:unknown}).text;
      if(typeof text==="string"&&text.trim())paragraphs.push(text.trim());
      const annotations=(part as {annotations?:unknown}).annotations;
      if(!Array.isArray(annotations))continue;
      for(const annotation of annotations){
        const source=publicSource(annotation);
        if(source&&!urls.has(source.url)&&sources.length<5){urls.add(source.url);sources.push(source);}
      }
    }
  }
  const answer=paragraphs.join("\n").slice(0,1500);
  return answer?{answer,sources}:null;
}

export function createWebSearch(deps:{fetch?:Fetch;apiKey?:string;model?:string;now?:()=>number}={}){
  const doFetch=deps.fetch??fetch,now=deps.now??Date.now;
  return async(query:string,budget?:WebSearchBudget):Promise<WebSearchResult>=>{
    const key=deps.apiKey??process.env.OPENAI_API_KEY;
    if(!key)return {available:false,reason:"notConfigured"};
    // Reserve one paid Responses call inside the same six-model-call turn budget.
    // No request is made when only the final no-tool answer slot remains.
    if(budget&&!budget.reserveModelCall())return {available:false,reason:"budget"};
    const started=now();
    try{
      const response=await doFetch("https://api.openai.com/v1/responses",{
        method:"POST",signal:AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
        headers:{"content-type":"application/json",Authorization:"Bearer "+key},
        body:JSON.stringify({
          model:deps.model??configuredSupervisorModel(),
          store:false,max_output_tokens:WEB_SEARCH_OUTPUT_TOKENS,
          tools:[{type:"web_search"}],
          input:"Search for current, public information on this question. Summarize only what sources support and cite their URLs. Question: "+query,
        }),
      });
      const durationMs=now()-started;
      if(!response.ok){
        console.error("agent_web_search_failed",{category:"http",status:response.status,durationMs});
        return {available:false,reason:"providerFailed"};
      }
      const body:unknown=await response.json();
      budget?.recordUsage(webSearchUsage(body));
      const parsed=extractWebSearchAnswer(body);
      if(!parsed){
        console.error("agent_web_search_failed",{category:"unreadable",durationMs});
        return {available:false,reason:"unreadable"};
      }
      console.info("agent_web_search_completed",{durationMs,sources:parsed.sources.length});
      return {available:true,...parsed};
    }catch(error){
      const timedOut=error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError");
      console.error("agent_web_search_failed",{category:timedOut?"timeout":"network",durationMs:now()-started});
      return {available:false,reason:timedOut?"timeout":"providerFailed"};
    }
  };
}
export const searchWeb=createWebSearch();
