import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {
  reservationForRequest,PaidReservation,constantTimeEqual,usageFromSseFrame,
  startTrustedBroker,MAX_CALLS,MAX_RESERVATION_MICROS
} from "./task14b-broker.mjs";
const head="a".repeat(40),key="sk-this_is_only_a_mocked_key";
const params={model:"gpt-6-luna",stream:true,max_output_tokens:1200,
 tools:[{type:"function",name:"inspect_supplier_purchase",parameters:{
  type:"object",properties:{},additionalProperties:false}}]};
const body=Buffer.from(JSON.stringify(params));
test("allows only priced foreground Luna Responses calls and reserves worst-case bytes",()=>{
 const r=reservationForRequest(body);
 assert.ok(r.reservedMicros>600);
 for(const bad of [
  {...params,model:"gpt-4.1-mini"},
  {...params,stream:false},
  {...params,background:true},
  {...params,service_tier:"priority"},
  {...params,max_output_tokens:1201},
  {...params,tools:[{type:"web_search_preview"}]},
  {...params,prompt_cache_retention:"24h"},
 ])assert.throws(()=>reservationForRequest(Buffer.from(JSON.stringify(bad))),
   /task14b_trusted_broker:/);
 assert.throws(()=>reservationForRequest(Buffer.from("x".repeat(120001))),
   /request_size/);
});
test("pre-reserves exactly 18 paid attempts, including unknown/failing transports",()=>{
 const b=new PaidReservation(head);
 for(let i=0;i<MAX_CALLS;i++)b.reserve(body);
 assert.equal(b.attempts,MAX_CALLS);
 assert.ok(b.reservedMicros<=MAX_RESERVATION_MICROS);
 assert.throws(()=>b.reserve(body),/approved_budget_exhausted/);
 assert.equal(b.receipts.length,MAX_CALLS);
});
test("cannot repeat a request after $0.18 cumulative pretransport reservation",()=>{
 const b=new PaidReservation(head);
 const large=Buffer.from(JSON.stringify({...params,input:"x".repeat(118_000)}));
 for(let i=0;i<18;i++){
  try{b.reserve(large)}catch(e){
   assert.match(String(e),/approved_budget_exhausted/);
   break;
  }
 }
 assert.ok(b.reservedMicros<=MAX_RESERVATION_MICROS);
 assert.ok(b.attempts<MAX_CALLS);
});
test("broker token is timing-safe and response usage is metadata-only",()=>{
 const t="x".repeat(64);
 assert.equal(constantTimeEqual(t,t),true);
 assert.equal(constantTimeEqual(t,t+"a"),false);
 assert.equal(constantTimeEqual(t,"x"),false);
 assert.equal(constantTimeEqual(t,null),false);
 const trace=usageFromSseFrame('event: response.completed\ndata: '+JSON.stringify({
  type:"response.completed",response:{model:"gpt-6-luna",
   service_tier:"standard",usage:{input_tokens:5000,output_tokens:180},
   output:[{type:"message",content:[{type:"output_text",text:"secret"}]}]}}));
 assert.deepEqual(trace,{event:"response.completed",input:5000,output:180,
  observedModel:"gpt-6-luna",serviceTier:"standard"});
 assert.equal(JSON.stringify(trace).includes("secret"),false);
});
test("only trusted broker calls real-key transport and never exposes the key",async()=>{
 const root=mkdtempSync(join(tmpdir(),"task14b-host-audit-")),auditFile=join(root,"audit.json");
 let called=0;
 const fetchUpstream=async(url,opts)=>{
  called++;
  assert.equal(url,"https://api.openai.com/v1/responses");
  assert.equal(opts.headers.Authorization,"Bearer "+key);
  const response=JSON.stringify({type:"response.completed",response:{
   model:"gpt-6-luna",service_tier:"standard",
   usage:{input_tokens:100,output_tokens:50}}});
  return new Response("event: response.completed\ndata: "+response+"\n\n",{
   status:200,headers:{"content-type":"text/event-stream"}
  });
 };
 const {server}=startTrustedBroker({apiKey:key,token:"z".repeat(64),
  head,auditFile,port:0,fetchUpstream});
 try{
  await once(server,"listening");
  const port=server.address().port,url="http://127.0.0.1:"+port;
  const unauthorized=await fetch(url+"/v1/responses",{
    method:"POST",body,headers:{authorization:"Bearer bad"}});
  assert.equal(unauthorized.status,403);
  const permitted=await fetch(url+"/v1/responses",{
    method:"POST",body,headers:{authorization:"Bearer "+"z".repeat(64)}});
  assert.equal(permitted.status,200);
  assert.match(await permitted.text(),/response.completed/);
  assert.equal(called,1);
  const audit=JSON.parse(readFileSync(auditFile,"utf8"));
  assert.equal(audit.attempts,1);
  assert.equal(audit.receipts[0].terminal,"completed");
  assert.equal(audit.receipts[0].actualOutputTokens,50);
  assert.equal(JSON.stringify(audit).includes(key),false);
  assert.equal(JSON.stringify(audit).includes("secret"),false);
 }finally{await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});}
});
