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
export function reservationForRequest(body) {
 if(!Buffer.isBuffer(body)||body.length<2||body.length>MAX_BODY_BYTES)
  fail("request_size");
 let p;
 try{p=JSON.parse(body.toString("utf8"))}catch{fail("invalid_json")}
 if(p===null||typeof p!=="object"||Array.isArray(p))
  fail("not_a_response_request");
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
  Math.ceil(body.length*0.10+p.max_output_tokens*0.50),params:p};
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
   terminal:"attempted"};
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
 if(obj?.type!=="response.completed"&&obj?.type!=="response.failed")
  return null;
 const u=obj.response?.usage;
 return {event:obj.type,input:Number.isSafeInteger(u?.input_tokens)?u.input_tokens:null,
  output:Number.isSafeInteger(u?.output_tokens)?u.output_tokens:null,
  observedModel:typeof obj.response?.model==="string"?obj.response.model:null,
  serviceTier:typeof obj.response?.service_tier==="string"?obj.response.service_tier:null};
}
function saveAudit(file,reservations) {
 const tmp=file+"."+randomUUID()+".tmp";
 writeFileSync(tmp,JSON.stringify(reservations.snapshot(),null,2)+"\n",
   {mode:0o600,flag:"wx"});
 renameSync(tmp,file);
}
export function startTrustedBroker({
 apiKey=process.env.OPENAI_API_KEY,
 token=process.env.AICAFE_TASK14B_BROKER_TOKEN,
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
    receipt.terminal="provider_rejected";saveAudit(auditFile,reserved);
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
       receipt.terminal=usage.event==="response.completed"?"completed":"provider_failed";
       receipt.actualInputTokens=usage.input;
       receipt.actualOutputTokens=usage.output;
       if(usage.observedModel!=="gpt-6-luna"||
         (usage.serviceTier&&
           !["standard","default","auto"].includes(usage.serviceTier)))
        receipt.terminal="unpriced_or_wrong_provider";
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
