#!/usr/bin/env node
/**
 * TRUSTED-MAIN ONLY. An isolated candidate may request OpenAI Responses through
 * this broker, but NEVER receives the raw OPENAI_API_KEY, host PID namespace,
 * budget files, or writable GitHub authorization token.
 *
 * Safety: strict allowlist, pre-request cumulative reservation, no retries,
 * no other API endpoints, no raw prompt/output logging, redacted host audit.
 * This must NOT be imported or executed from PR #482 candidate source.
 */
import {createServer} from "node:http";
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import {randomUUID,timingSafeEqual} from "node:crypto";

export const MAX_RESERVATION_MICROS=180_000;
export const MAX_CALLS=18;
export const MAX_BODY_BYTES=120_000;
export const MAX_OUTPUT_TOKENS=1_200;
const fail=(code)=>{throw new Error("task14b_trusted_broker:"+code);};
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const onlyKeys=(obj,keys)=>Object.keys(obj).every(key=>keys.includes(key));
const inlineId=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const inlineName=x=>typeof x==="string"&&/^[a-z][a-z0-9_]{1,79}$/.test(x);
/**
 * Never forward provider-stored context: previous_response_id, conversation,
 * prompt IDs, reasoning references, file IDs/URLs, image URLs or attachments.
 * Canonicalize recorded Responses output to self-contained text/function items.
 * Provider can bill only for text/tool JSON physically in this request.
 */
export function normalizeInlineContext(items){
 if(!Array.isArray(items)||items.length<1||items.length>256)
  fail("inline_input_required");
 return items.map(item=>{
  if(!isObject(item))fail("non_inline_input");
  if(item.type===undefined&&["developer","user","assistant"].includes(item.role)){
   if(!onlyKeys(item,["role","content"]))fail("remote_message_metadata_forbidden");
   if(typeof item.content==="string")
    return {role:item.role,content:item.content};
   if(item.role!=="user"||!Array.isArray(item.content)||
      !item.content.length)fail("unsupported_message_content");
   const content=item.content.map(part=>{
    if(!isObject(part)||!onlyKeys(part,["type","text"])||
       part.type!=="input_text"||typeof part.text!=="string")
      fail("remote_or_nontext_attachment_forbidden");
    return {type:"input_text",text:part.text};
   });
   return {role:"user",content};
  }
  if(item.type==="function_call"){
   if(!onlyKeys(item,["type","id","status","name","call_id","arguments"])||
      !inlineName(item.name)||!inlineId(item.call_id)||
      typeof item.arguments!=="string")fail("non_inline_function_call");
   // Remove provider-generated opaque item IDs; preserve the inline call
   // name+arguments and call_id needed for the function output correlation.
   return {type:"function_call",name:item.name,
    call_id:item.call_id,arguments:item.arguments};
  }
  if(item.type==="function_call_output"){
   if(!onlyKeys(item,["type","call_id","output"])||
      !inlineId(item.call_id)||typeof item.output!=="string")
    fail("non_inline_function_output");
   return {type:"function_call_output",call_id:item.call_id,output:item.output};
  }
  if(item.type==="message"){
   if(!onlyKeys(item,["type","id","status","role","content"])||
      item.role!=="assistant"||!Array.isArray(item.content))
    fail("non_inline_assistant_message");
   const content=item.content.map(part=>{
    if(!isObject(part)||!onlyKeys(part,["type","text","annotations"])||
       part.type!=="output_text"||typeof part.text!=="string"||
       (part.annotations!==undefined&&
        (!Array.isArray(part.annotations)||part.annotations.length!==0)))
      fail("remote_assistant_content_forbidden");
    return {type:"output_text",text:part.text,annotations:[]};
   });
   return {type:"message",role:"assistant",content};
  }
  // Reasoning IDs, remote file/image parts and all other opaque provider
  // item classes can expand to unbounded hidden/remote context.
  fail("opaque_or_remote_context_forbidden");
 });
}
export function reservationForRequest(body) {
 if(!Buffer.isBuffer(body)||body.length<2||body.length>MAX_BODY_BYTES)
  fail("request_size");
 let p;
 try{p=JSON.parse(body.toString("utf8"))}catch{fail("invalid_json")}
 if(p===null||typeof p!=="object"||Array.isArray(p))
  fail("not_a_response_request");
 const allowed=["model","instructions","tools","tool_choice","stream",
  "max_output_tokens","prompt_cache_key","input","service_tier"];
 if(!onlyKeys(p,allowed))fail("provider_expanded_context_forbidden");
 if(typeof p.instructions!=="string"||!p.instructions.trim()||
    (p.prompt_cache_key!==undefined&&
      (typeof p.prompt_cache_key!=="string"||p.prompt_cache_key.length>128))||
    !["none","auto"].includes(p.tool_choice))
  fail("unsupported_provider_request_shape");
 const input=normalizeInlineContext(p.input);
 if(p.model!=="gpt-6-luna")fail("unexpected_model");
 if(!Number.isSafeInteger(p.max_output_tokens)||p.max_output_tokens<1||
    p.max_output_tokens>MAX_OUTPUT_TOKENS)fail("output_cap");
 if(p.service_tier!==undefined&&!["standard","default","auto"].includes(p.service_tier))
  fail("unpriced_service_tier");
 if(p.background===true||p.stream!==true)fail("must_stream_foreground");
 if(p.prompt_cache_retention==="24h")fail("unpriced_cache_storage");
 if(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some(t=>!t||
    typeof t!=="object"||t.type!=="function")))
  fail("provider_built_in_tools_forbidden");
 // One token per serialized UTF-8 byte is a conservative upper allowance.
 // Current standard Luna rates $0.10/M input, $0.50/M output; no cache discount.
 // Multiplying tokens by dollar-per-million gives USD millionths ("micros").
 return {serializedBytes:body.length,reservedMicros:
  Math.ceil(body.length*0.10+p.max_output_tokens*0.50),params:{...p,input}};
}
/** The provider error body is untrusted. Audit only fixed categories and an
 * already submitted tool name; NEVER persist provider prose or raw content. */
export function safeProviderRejection(raw,tools=[]){
 const unknown={type:"unknown",code:"unknown",param:"unknown",toolName:null};
 if(typeof raw!=="string"||raw.length>4096)return unknown;
 let data;try{data=JSON.parse(raw)}catch{return unknown}
 const e=data?.error;
 if(!isObject(e))return unknown;
 const types=new Set(["invalid_request_error","authentication_error",
  "permission_error","rate_limit_error","server_error"]);
 const codes=new Set(["invalid_function_parameters","invalid_request_error",
  "unsupported_parameter","unsupported_value","model_not_found","invalid_model",
  "invalid_service_tier","context_length_exceeded","invalid_api_key",
  "insufficient_quota","permission_denied","invalid_prompt","invalid_value"]);
 const type=types.has(e.type)?e.type:"unknown";
 const code=codes.has(e.code)?e.code:"unknown";
 const allowedParams=new Set(["model","service_tier","tools","input",
  "instructions","tool_choice","max_output_tokens","prompt_cache_key",
  "stream","response_format"]);
 let param=allowedParams.has(e.param)?e.param:"unknown";
 const m=typeof e.param==="string"?
  /^tools\[(\d{1,3})\](?:\.(parameters|strict|name|description)(?:\..*)?)?$/.exec(e.param):null;
 if(m)param="tools["+m[1]+"]"+(m[2]?"."+m[2]:"");
 const names=new Set((Array.isArray(tools)?tools:[]).map(t=>t?.name)
  .filter(n=>typeof n==="string"&&inlineName(n)));
 const match=typeof e.message==="string"&&e.message.length<=4096?
  /Invalid schema for function ['"]([a-z][a-z0-9_]{1,79})['"]/.exec(e.message):null;
 const toolName=match&&names.has(match[1])?match[1]:null;
 return {type,code,param,toolName};
}
async function boundedErrorText(body){
 if(!body)return "";
 const reader=body.getReader(),chunks=[];
 let size=0;
 try{
  while(size<4096){
   const part=await reader.read();
   if(part.done)break;
   const chunk=Buffer.from(part.value);
   const taken=chunk.subarray(0,4096-size);
   chunks.push(taken);size+=taken.length;
   if(taken.length<chunk.length)break;
  }
 }catch{return ""}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 return Buffer.concat(chunks).toString("utf8");
}

export class PaidReservation {
 constructor(head){if(!/^[a-f0-9]{40}$/.test(head))fail("bad_head");
  this.head=head;this.attempts=0;this.reservedMicros=0;this.receipts=[]}
 reserve(body){
  const {serializedBytes,reservedMicros,params}=reservationForRequest(body);
  if(this.attempts>=MAX_CALLS||
    this.reservedMicros+reservedMicros>MAX_RESERVATION_MICROS)
   fail("approved_budget_exhausted");
  this.attempts++;this.reservedMicros+=reservedMicros;
  const receipt={ordinal:this.attempts,model:"gpt-6-luna",
   requestBytes:serializedBytes,reservedMicros,
   upstreamStatus:null,actualInputTokens:null,actualOutputTokens:null,
   toolNames:[],terminal:"attempted"};
  this.receipts.push(receipt);
  return {receipt,params};
 }
 snapshot(){return {head:this.head,attempts:this.attempts,
  reservedMicros:this.reservedMicros,receipts:this.receipts.map(r=>({...r})),
  objectiveCompetitorParity:"NOT_ATTESTED"}}
}
export function constantTimeEqual(a,b) {
 if(typeof a!=="string"||typeof b!=="string")return false;
 const x=Buffer.from(a),y=Buffer.from(b);
 return x.length===y.length&&x.length>20&&timingSafeEqual(x,y);
}
/** Streaming receipt captures only provider usage, never response text/tools. */
export function usageFromSseFrame(frame) {
 const line=frame.split(/\r?\n/).find(v=>v.startsWith("data: "));
 if(!line||line==="data: [DONE]")return null;
 let obj;try{obj=JSON.parse(line.slice(6))}catch{return null}
 if(obj?.type==="response.output_item.added"){
  const item=obj.item;
  if(item?.type==="function_call"&&typeof item.name==="string"&&
      /^[a-z][a-z0-9_]{1,79}$/.test(item.name))
    return {event:"function_call",name:item.name};
  return null;
 }
 if(obj?.type!=="response.completed"&&obj?.type!=="response.failed")
  return null;
 const u=obj.response?.usage;
 const toolNames=Array.isArray(obj.response?.output)?
  obj.response.output.filter(x=>x?.type==="function_call"&&
   typeof x.name==="string"&&/^[a-z][a-z0-9_]{1,79}$/.test(x.name))
    .map(x=>x.name).slice(0,30):[];
 return {event:obj.type,input:Number.isSafeInteger(u?.input_tokens)?u.input_tokens:null,
  output:Number.isSafeInteger(u?.output_tokens)?u.output_tokens:null,
  observedModel:typeof obj.response?.model==="string"?obj.response.model:null,
  serviceTier:typeof obj.response?.service_tier==="string"?obj.response.service_tier:null,
  toolNames};
}
function saveAudit(file,reservations) {
 const tmp=file+"."+randomUUID()+".tmp";
 writeFileSync(tmp,JSON.stringify(reservations.snapshot(),null,2)+"\n",
   {mode:0o600,flag:"wx"});
 renameSync(tmp,file);
}
export function startTrustedBroker({
 apiKey=process.env.OPENAI_API_KEY,
 token=process.env.AICAFE_14B_BROKER_TOKEN,
 head=process.env.HEAD_SHA,
 auditFile=process.env.AICAFE_TASK14B_HOST_AUDIT,
 port=8788,
 fetchUpstream=fetch
}={}){
 if(typeof apiKey!=="string"||!/^sk-[A-Za-z0-9_-]{15,}$/.test(apiKey))
  fail("provider_key_missing");
 if(typeof token!=="string"||token.length<40)fail("broker_token_missing");
 if(typeof auditFile!=="string"||!auditFile.startsWith("/"))fail("audit_path_missing");
 const reserved=new PaidReservation(head);
 saveAudit(auditFile,reserved);
 const server=createServer(async(req,res)=>{
  if(req.method==="GET"&&req.url==="/healthz"){
   res.writeHead(200,{"content-type":"text/plain","cache-control":"no-store"});
   res.end("ok");return;
  }
  if(req.method!=="POST"||req.url!=="/v1/responses"||
    !constantTimeEqual(req.headers.authorization?.replace(/^Bearer /,""),token)){
   res.writeHead(403);res.end();return;
  }
  let parts=[],size=0;
  try{
   for await(const chunk of req){
    size+=chunk.length;
    if(size>MAX_BODY_BYTES)fail("request_size");
    parts.push(chunk);
   }
   const body=Buffer.concat(parts);
   const {receipt,params}=reserved.reserve(body);
   // Write the reservation synchronously BEFORE opening billable transport.
   saveAudit(auditFile,reserved);
   parts=[];
   let upstream;
   try{
    upstream=await fetchUpstream("https://api.openai.com/v1/responses",{
     method:"POST",headers:{
      Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
     body:JSON.stringify({...params,service_tier:"default"}),
     signal:AbortSignal.timeout(180_000),
    });
   }catch{
    receipt.terminal="transport_unknown";saveAudit(auditFile,reserved);
    res.writeHead(502);res.end();return;
   }
   receipt.upstreamStatus=upstream.status;
   if(!upstream.ok||!upstream.body){
    receipt.terminal="provider_rejected";
    receipt.rejection=safeProviderRejection(await boundedErrorText(upstream.body),params.tools);
    saveAudit(auditFile,reserved);
    res.writeHead(502);res.end();return;
   }
   res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8",
    "cache-control":"no-store","x-accel-buffering":"no"});
   const decoder=new TextDecoder();let remaining="";
   try{
    for await(const chunk of upstream.body){
     if(res.destroyed)break;
     res.write(chunk);
     remaining+=decoder.decode(chunk,{stream:true});
     let match;
     while((match=/\r?\n\r?\n/.exec(remaining))!==null){
      const frame=remaining.slice(0,match.index);
      remaining=remaining.slice(match.index+match[0].length);
      // Do not store content or raw full request; only usage and model identity.
      const usage=usageFromSseFrame(frame);
      if(usage){
       if(usage.event==="function_call"){
        if(receipt.toolNames.length<30)receipt.toolNames.push(usage.name);
       }else{
        receipt.terminal=usage.event==="response.completed"?"completed":"provider_failed";
        receipt.actualInputTokens=usage.input;
        receipt.actualOutputTokens=usage.output;
        // Some providers omit output_item.added. A completed response's
        // function_call item names still attest tool selection without args.
        if(receipt.toolNames.length===0)receipt.toolNames.push(...usage.toolNames);
        if(usage.observedModel!=="gpt-6-luna"||
          (usage.serviceTier&&
            !["standard","default","auto"].includes(usage.serviceTier)))
         receipt.terminal="unpriced_or_wrong_provider";
       }
      }
      if(remaining.length>1_000_000)remaining=remaining.slice(-4096);
     }
    }
   }finally{
    if(receipt.terminal==="attempted")receipt.terminal="incomplete";
    saveAudit(auditFile,reserved);
    res.end();
   }
  }catch{
   // A forbidden request never reaches upstream. No raw errors returned.
   res.writeHead(400);res.end();
  }
 });
 server.listen(port,"127.0.0.1");
 return {server,reserved};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])
 startTrustedBroker();
