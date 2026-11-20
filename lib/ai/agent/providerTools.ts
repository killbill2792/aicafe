/**
 * Provider-native hosted discovery is a transport projection of the EXISTING
 * allowed registry. It neither grants permissions nor executes a tool.
 * https://developers.openai.com/api/docs/guides/tools-tool-search
 */
import {PRODUCTION_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
type Row=Record<string,unknown>;
const object=(x:unknown):x is Row=>!!x&&typeof x==="object"&&!Array.isArray(x);
const namePattern=/^[a-z][a-z0-9_]{1,79}$/;
const inlineCall=/^[A-Za-z0-9_-]{1,128}$/;
export type ProviderFunctionCall={type:"function_call";name:string;arguments:string;call_id:string;namespace?:string};
export function usesNativeToolSearch(model:string,isolatedLegacy:boolean):boolean{
 return model===PRODUCTION_SUPERVISOR_OPENAI_MODEL&&!isolatedLegacy;
}
export function projectProviderTools(definitions:readonly unknown[],native:boolean):unknown[]{
 const seen=new Set<string>();
 const functions=definitions.map(raw=>{
  if(!object(raw)||raw.type!=="function"||typeof raw.name!=="string"||
   !namePattern.test(raw.name)||seen.has(raw.name)||raw.strict!==true)
    throw Error("invalid_provider_tool_registry");
  seen.add(raw.name);
  return native?{...raw,defer_loading:true}:raw;
 });
 // No invented business categories, intent router, custom search tool or second registry.
 return native&&functions.length?[...functions,{type:"tool_search"}]:functions;
}
export function allowedFunctionNames(definitions:readonly unknown[]):ReadonlySet<string>{
 return new Set(definitions.flatMap(d=>object(d)&&d.type==="function"&&typeof d.name==="string"?[d.name]:[]));
}
/** The flat deferred-function wire form permits a namespace equal to its own
 * name. Reject a conflicting namespace rather than selecting a different tool. */
export function validProviderFunctionCall(raw:unknown):raw is ProviderFunctionCall{
 return object(raw)&&raw.type==="function_call"&&typeof raw.name==="string"&&namePattern.test(raw.name)&&
  typeof raw.call_id==="string"&&inlineCall.test(raw.call_id)&&typeof raw.arguments==="string"&&
  (raw.namespace===undefined||raw.namespace===null||raw.namespace===raw.name);
}
/** Search output may select only declarations from this request. Never accept
 * a provider-returned schema as the authoritative local execution contract. */
export function validateHostedToolOutput(items:readonly unknown[],definitions:readonly unknown[],native:boolean){
 const allowed=allowedFunctionNames(definitions);
 let pending=0;
 for(const raw of items){
  if(!object(raw))continue;
  if(raw.type==="tool_search_call"){
   if(!native||raw.execution!=="server"||raw.call_id!==null||raw.status!=="completed")
    throw Error("unexpected_provider_tool_search");
   pending++;
  }else if(raw.type==="tool_search_output"){
   if(!native||pending===0||raw.execution!=="server"||raw.call_id!==null||
    raw.status!=="completed"||!Array.isArray(raw.tools)||
    raw.tools.some(t=>!object(t)||t.type!=="function"||typeof t.name!=="string"||!allowed.has(t.name)))
     throw Error("invalid_provider_tool_search_output");
   pending--;
  }
 }
 if(pending!==0)throw Error("unpaired_provider_tool_search");
}

// Reuse the request's trusted schema and description on replay, not an
// amplified or altered definition from a returned discovery item.
export function canonicalHostedOutput(items:readonly unknown[],definitions:readonly unknown[],native:boolean):unknown[]{
 validateHostedToolOutput(items,definitions,native);
 const byName=new Map(definitions.flatMap(d=>object(d)&&d.type==="function"&&typeof d.name==="string"?[[d.name,d] as const]:[]));
 return items.map(raw=>{
  if(!object(raw)||raw.type!=="tool_search_output")return raw;
  return {...raw,tools:(raw.tools as Row[]).map(t=>byName.get(t.name as string)!)};
 });
}
