import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {
  reservationForRequest,PaidReservation,constantTimeEqual,usageFromSseFrame,
  safeProviderRejection,startTrustedBroker,safePolicyDenial,MAX_CALLS,MAX_RESERVATION_MICROS
} from "./task14b-broker.mjs";
const head="a".repeat(40),key="sk-this_is_only_a_mocked_key";
const params={model:"gpt-6-luna",stream:true,max_output_tokens:1200,
 instructions:"Only grounded café evidence. No external writes.",
 tool_choice:"auto",prompt_cache_key:"cafe-agent-test",
 input:[{role:"user",content:"Compare supplier quotes for milk."}],
 tools:[{type:"function",name:"inspect_supplier_purchase",parameters:{
  type:"object",properties:{},additionalProperties:false}}]};
const body=Buffer.from(JSON.stringify(params));

test("actual trusted authorization JavaScript accepts one v6-only marker and rejects duplicate v6",()=>{
 const yaml=readFileSync(".github/workflows/ai-cafe-14b-bounded-live.yml","utf8");
 const match=yaml.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/);
 assert.ok(match,"owner authorization block must be discoverable");
 const block=match[1].split("\n").map(line=>line.replace(/^ {10}/,"")).join("\n");
 const sha="a".repeat(40),prefix="<!-- aicafe-task14b-trusted-paid-run-v6 ";
 const marker=prefix+sha+" -->";
 const root=mkdtempSync(join(tmpdir(),"task14b-owner-auth-"));
 try{
  for(const [label,body,expected] of [
   ["single-v6", "Owner acceptance\n"+marker,0],
   ["duplicate-v6","Owner acceptance\n"+marker+"\n"+marker,1],
   ["old-v1-only","<!-- aicafe-task14b-trusted-paid-run "+sha+" -->",1],
   ["old-v2-only","<!-- aicafe-task14b-trusted-paid-run-v2 "+sha+" -->",1],
   ["old-v3-only","<!-- aicafe-task14b-trusted-paid-run-v3 "+sha+" -->",1],
   ["old-v4-only","<!-- aicafe-task14b-trusted-paid-run-v4 "+sha+" -->",1],
   ["old-v5-only","<!-- aicafe-task14b-trusted-paid-run-v5 "+sha+" -->",1]
  ]){
   const event={action:"edited",sender:{login:"killbill2792"},
    repository:{full_name:"killbill2792/aicafe"},
    changes:{body:{from:"Owner acceptance"}},
    pull_request:{number:482,user:{login:"killbill2792"},
     head:{sha,ref:"task14b-agentic-supervisor-procurement",
      repo:{full_name:"killbill2792/aicafe"}},
     base:{ref:"main"},body}};
   const eventFile=join(root,label+"-event.json");
   const outputFile=join(root,label+"-output.txt");
   writeFileSync(eventFile,JSON.stringify(event));
   const live={head:{sha},base:{ref:"main"},body,state:"open"};
   const prelude="const mockedPull="+JSON.stringify(live)+";\n"+
    'globalThis.fetch=async(url,opts={})=>{\n'+
    ' const u=String(url);\n'+
    ' if(u.endsWith("/pulls/482"))return new Response(JSON.stringify(mockedPull),{status:200});\n'+
    ' if(u.includes("/issues/482/comments?"))return new Response("[]",{status:200});\n'+
    ' if(u.endsWith("/issues/482/comments")&&opts.method==="POST")return new Response("{}",{status:201});\n'+
    ' throw Error("Unexpected network access in mock");\n};\n';
   const child=spawnSync(process.execPath,["--input-type=module"],{
    input:prelude+block,encoding:"utf8",
    env:{...process.env,GH_TOKEN:"mock-owner-token",
     GITHUB_EVENT_PATH:eventFile,GITHUB_OUTPUT:outputFile,
     GITHUB_RUN_ATTEMPT:"1",GITHUB_TRIGGERING_ACTOR:"killbill2792"}
   });
   assert.equal(child.status,expected,label+": "+child.stderr);
   if(expected===0)assert.equal(readFileSync(outputFile,"utf8"),"head="+sha+"\n");
   else assert.match(child.stderr,/Fresh exact-head owner approval required/);
  }
 }finally{rmSync(root,{recursive:true,force:true})}
});

test("trusted workflow uses a NEW owner-only v6 grant, never replays consumed v1",()=>{
 const workflow=readFileSync(".github/workflows/ai-cafe-14b-bounded-live.yml","utf8");
 assert.match(workflow,/const prefix="<!-- aicafe-task14b-trusted-paid-run-v6 "/);
 assert.match(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v6 -->"/);
 assert.match(workflow,/github\.actor == 'killbill2792'/);
 assert.match(workflow,/github\.run_attempt == 1/);
 assert.match(workflow,/event\.changes\?\.body\?\.from/);
 assert.match(workflow,/if\(comments\.some\(c=>String\(c\.body\|\|""\)\.includes\(consumed\)\)\)/);
 assert.match(workflow,/task14b_host_failure/);
 assert.doesNotMatch(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v1 -->"/);
 assert.doesNotMatch(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v2 -->"/);
 assert.doesNotMatch(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v3 -->"/);
 assert.doesNotMatch(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v4 -->"/);
 assert.doesNotMatch(workflow,/const consumed="<!-- aicafe-task14b-authorization-consumed:pr482:pilot-v5 -->"/);
 assert.match(workflow,/policyDenials/);
});

test("provider rejection audit retains only safe code, parameter family and known function",async()=>{
 const raw=JSON.stringify({error:{
  type:"invalid_request_error",code:"invalid_function_parameters",
  param:"tools[0].parameters.properties.Private_Supplier_SSN",
  message:"Invalid schema for function 'inspect_supplier_purchase': SECRET_PRIVATE_SUPPLIER_NOTE"
 }});
 const expected={type:"invalid_request_error",code:"invalid_function_parameters",
  param:"tools[0].parameters",toolName:"inspect_supplier_purchase"};
 assert.deepEqual(safeProviderRejection(raw,params.tools),expected);
 assert.deepEqual(safeProviderRejection(JSON.stringify({error:{
  type:"PRIVATE_OWNER_NAME",code:"SECRET_PRIVATE_SUPPLIER_NOTE",param:"owner_private_id",
  message:"Invalid schema for function 'private_supplier_token': SECRET_PRIVATE_SUPPLIER_NOTE"
 }}),params.tools),{type:"unknown",code:"unknown",param:"unknown",toolName:null});
 assert.deepEqual(safeProviderRejection("x".repeat(4097),params.tools),
  {type:"unknown",code:"unknown",param:"unknown",toolName:null});
 const root=mkdtempSync(join(tmpdir(),"task14b-http400-redaction-")),auditFile=join(root,"audit.json");
 let called=0;
 const {server}=startTrustedBroker({apiKey:key,token:"z".repeat(64),head,auditFile,port:0,
  fetchUpstream:async()=>{
   called++;
   return new Response(raw,{status:400,headers:{"content-type":"application/json"}});
  }});
 try{
  await once(server,"listening");
  const response=await fetch("http://127.0.0.1:"+server.address().port+"/v1/responses",{
   method:"POST",body,headers:{authorization:"Bearer "+"z".repeat(64)}});
  assert.equal(response.status,502);
  assert.equal(await response.text(),"","provider body never forwarded to candidate");
  const audit=JSON.parse(readFileSync(auditFile,"utf8"));
  assert.equal(called,1);
  assert.equal(audit.attempts,1);
  assert.equal(audit.receipts[0].upstreamStatus,400);
  assert.equal(audit.receipts[0].terminal,"provider_rejected");
  assert.deepEqual(audit.receipts[0].rejection,expected);
  assert.equal(JSON.stringify(audit).includes("SECRET_PRIVATE_SUPPLIER_NOTE"),false);
  assert.equal(JSON.stringify(audit).includes("Private_Supplier_SSN"),false);
  assert.equal(JSON.stringify(audit).includes(key),false);
 }finally{await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});}
});

test("broker refuses opaque continuation before any spend and persists only allowlisted denial code",async()=>{
 const opaque="rs_DO_NOT_LOG_OWNER_PRIVATE_CONTEXT";
 assert.equal(safePolicyDenial(new Error("task14b_trusted_broker:opaque_or_remote_context_forbidden")),
   "opaque_or_remote_context_forbidden");
 assert.equal(safePolicyDenial(new Error(opaque)),"unknown");
 const root=mkdtempSync(join(tmpdir(),"task14b-local-rejection-")),auditFile=join(root,"audit.json");
 let upstream=0;
 const {server}=startTrustedBroker({apiKey:key,token:"z".repeat(64),head,auditFile,port:0,
   fetchUpstream:async()=>{
     upstream++;
     return new Response("data: "+JSON.stringify({type:"response.completed",response:{
       model:"gpt-6-luna",service_tier:"default",
       usage:{input_tokens:40,output_tokens:12}}})+"\n\n",
       {status:200,headers:{"content-type":"text/event-stream"}});
   }});
 try{
   await once(server,"listening");
   const url="http://127.0.0.1:"+server.address().port+"/v1/responses";
   const headers={authorization:"Bearer "+"z".repeat(64)};
   const denied=await fetch(url,{method:"POST",headers,body:JSON.stringify({
     ...params,input:[{type:"reasoning",id:opaque,summary:[]}],
   })});
   assert.equal(denied.status,400);assert.equal(await denied.text(),"");
   let audit=JSON.parse(readFileSync(auditFile,"utf8"));
   assert.equal(upstream,0);assert.equal(audit.attempts,0);
   assert.equal(audit.deniedCount,1);
   assert.deepEqual(audit.policyDenials,["invalid_inline_reasoning"]);
   assert.equal(JSON.stringify(audit).includes(opaque),false);
   assert.equal(JSON.stringify(audit).includes(key),false);
   const accepted=await fetch(url,{method:"POST",headers,body:JSON.stringify({
     ...params,input:[
       {role:"user",content:"Read my saved orders."},
       {type:"function_call",name:"inspect_supplier_purchase",
         call_id:"call_1",arguments:"{}"},
       {type:"function_call_output",call_id:"call_1",output:"{}"}]
   })});
   assert.equal(accepted.status,200);await accepted.text();
   audit=JSON.parse(readFileSync(auditFile,"utf8"));
   assert.equal(upstream,1);assert.equal(audit.attempts,1);
   assert.equal(audit.deniedCount,1);
   assert.equal(audit.receipts[0].terminal,"completed");
 }finally{
   await new Promise(resolve=>server.close(resolve));
   rmSync(root,{recursive:true,force:true});
 }
});

test("v5: one provider-issued encrypted reasoning item is replayed with function outputs, at bounded cost",async()=>{
 const root=mkdtempSync(join(tmpdir(),"task14b-provenance-"));
 const auditFile=join(root,"audit.json");
 const origin={type:"reasoning",id:"rs_local_test_1",status:"completed",summary:[],
   encrypted_content:"U".repeat(512)};
 const event=(type,value)=>"event: "+type+"\ndata: "+JSON.stringify({type,...value})+"\n\n";
 const calls=[];
 const {server}=startTrustedBroker({apiKey:key,token:"z".repeat(64),head,auditFile,port:0,
   fetchUpstream:async(url,init)=>{
     calls.push(JSON.parse(init.body));
     assert.equal(url,"https://api.openai.com/v1/responses");
     assert.equal(JSON.parse(init.body).store,false,"trusted host never stores a remote response");
     const frames=calls.length===1?[
       event("response.output_item.done",{item:origin}),
       event("response.output_item.done",{item:{type:"function_call",
         name:"inspect_supplier_purchase",call_id:"call_1",arguments:"{}"}}),
       event("response.completed",{response:{model:"gpt-6-luna",service_tier:"default",
         usage:{input_tokens:200,output_tokens:120}}})
     ]:[
       event("response.completed",{response:{model:"gpt-6-luna",service_tier:"default",
         usage:{input_tokens:300,output_tokens:30}}})
     ];
     return new Response(frames.join(""),{
       status:200,headers:{"content-type":"text/event-stream"}});
   }});
 try{
   await once(server,"listening");
   const url="http://127.0.0.1:"+server.address().port+"/v1/responses";
   const headers={authorization:"Bearer "+"z".repeat(64)};
   const first=await fetch(url,{method:"POST",headers,body:JSON.stringify({...params,store:false})});
   assert.equal(first.status,200);
   await first.text();
   const replay=[
     {role:"user",content:"Investigate purchase."},
     origin,
     {type:"function_call",name:"inspect_supplier_purchase",
       call_id:"call_1",arguments:"{}"},
     {type:"function_call_output",call_id:"call_1",output:"{\"offers\":[]}"},
   ];
   const invalid=await fetch(url,{method:"POST",headers,body:JSON.stringify({
     ...params,store:false,input:replay.map(x=>
       x===origin?{...origin,encrypted_content:"V".repeat(512)}:x),
   })});
   assert.equal(invalid.status,400,"candidate cannot substitute remote reasoning");
   assert.equal(await invalid.text(),"");
   const missingStore=await fetch(url,{method:"POST",headers,body:JSON.stringify({
     ...params,input:replay
   })});
   assert.equal(missingStore.status,400,"encrypted replay needs explicit store:false");
   const secondBody=Buffer.from(JSON.stringify({...params,store:false,input:replay}));
   const second=await fetch(url,{method:"POST",headers,body:secondBody});
   assert.equal(second.status,200);
   await second.text();
   assert.equal(calls.length,2,"invalid reasoning never reaches paid transport");
   assert.equal(calls[1].input[1].id,origin.id);
   assert.equal(calls[1].input[1].encrypted_content,origin.encrypted_content);
   assert.equal(calls[1].input[2].call_id,"call_1");
   assert.equal(calls[1].input[3].call_id,"call_1");
   const audit=JSON.parse(readFileSync(auditFile,"utf8"));
   assert.equal(audit.attempts,2);
   assert.equal(audit.deniedCount,2);
   assert.deepEqual(audit.policyDenials,[
     "unissued_reasoning_context","stateless_reasoning_required"]);
   const base=reservationForRequest(secondBody,
     new Map([[createHash("sha256").update(origin.id+"\n"+origin.encrypted_content)
       .digest("hex"),{id:origin.id,outputCeiling:1200}]]));
   assert.ok(base.reservedMicros>=
     Math.ceil(secondBody.length*0.10+1200*0.10+1200*0.50));
   assert.equal(audit.reservedMicros,
     reservationForRequest(Buffer.from(JSON.stringify({...params,store:false}))).reservedMicros+
     base.reservedMicros);
   const serial=JSON.stringify(audit);
   assert.equal(serial.includes(origin.encrypted_content),false);
   assert.equal(serial.includes(origin.id),false);
   assert.equal(serial.includes(key),false);
 }finally{
   await new Promise(resolve=>server.close(resolve));
   rmSync(root,{recursive:true,force:true});
 }
});

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
test("rejects provider-expanded history, prompts, remote files and images before cost reservation",()=>{
 const blocked=[
  {...params,previous_response_id:"resp_stored_history"},
  {...params,conversation:"conv_stored_history"},
  {...params,prompt:{id:"prompt_stored"}},
  {...params,store:true},
  {...params,input:[{type:"reasoning",id:"rs_unpriced",summary:[]}]},
  {...params,input:[{role:"user",content:[{type:"input_image",image_url:"https://remote.example/image.jpg"}]}]},
  {...params,input:[{role:"user",content:[{type:"input_file",file_id:"file_unpriced"}]}]},
  {...params,input:[{role:"user",content:[{type:"input_text",text:"Hi",file_id:"file_unpriced"}]}]},
  {...params,input:[{role:"user",content:[{type:"input_text",text:"Hi",url:"https://remote.example/data"}]}]},
  {...params,input:[{type:"message",role:"assistant",id:"msg_opaque"}]},
 ];
 for(const [i,p] of blocked.entries()){
  assert.throws(()=>reservationForRequest(Buffer.from(JSON.stringify(p))),
    /task14b_trusted_broker:/,"remote reference index "+i);
 }
 const b=new PaidReservation(head);
 for(const p of blocked)assert.throws(()=>b.reserve(Buffer.from(JSON.stringify(p))));
 assert.equal(b.attempts,0);
 assert.equal(b.reservedMicros,0);
});
test("normalizes only self-contained function-tool history and strips provider item IDs",()=>{
 const request={...params,input:[
  {role:"developer",content:"Grounded procurement only"},
  {role:"user",content:[{type:"input_text",text:"Compare quotes"}]},
  {type:"function_call",id:"fc_opaque",status:"completed",
   name:"inspect_supplier_purchase",call_id:"call_1",arguments:'{"item":"milk"}'},
  {type:"function_call_output",call_id:"call_1",output:'{"available":true}'},
  {type:"message",id:"msg_opaque",status:"completed",
   role:"assistant",content:[{type:"output_text",text:"Two verified quotes.",annotations:[]}]}
 ]};
 const r=reservationForRequest(Buffer.from(JSON.stringify(request)));
 assert.equal(r.params.input.length,5);
 assert.equal(r.params.input[2].call_id,"call_1");
 assert.equal(r.params.input[2].id,undefined);
 assert.equal(r.params.input[4].id,undefined);
 assert.equal(JSON.stringify(r.params).includes("fc_opaque"),false);
 assert.equal(JSON.stringify(r.params).includes("msg_opaque"),false);
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
 const large=Buffer.from(JSON.stringify({...params,input:[{role:"user",content:"x".repeat(118_000)}]}));
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
  observedModel:"gpt-6-luna",serviceTier:"standard",toolNames:[]});
 assert.equal(JSON.stringify(trace).includes("secret"),false);
});

test("candidate shim forwards only local proxy authorization; raw bearer is never forwarded",()=>{
 const script=`
  globalThis.fetch=async(url,init)=>({url,init});
  require("./scripts/acceptance/task14b-fetch-shim.cjs");
  Promise.all([
    fetch("https://api.openai.com/v1/responses",{method:"POST",
      headers:{Authorization:"Bearer sk-raw_candidate_must_never_escape"},
      body:'{"model":"gpt-6-luna","stream":true}'}),
    fetch("https://example.org/no-secret",{method:"GET"})
  ]).then(rows=>console.log(JSON.stringify(rows))).catch(e=>{
    console.error(e.message);process.exitCode=1});
 `;
 const child=spawnSync(process.execPath,["-e",script],{
  cwd:process.cwd(),encoding:"utf8",
  env:{...process.env,AICAFE_14B_BROKER_TOKEN:"z".repeat(64)}});
 assert.equal(child.status,0,child.stderr);
 const [proxied,ordinary]=JSON.parse(child.stdout.trim());
 assert.equal(proxied.url,"http://127.0.0.1:8788/v1/responses");
 assert.equal(proxied.init.headers.authorization,"Bearer "+"z".repeat(64));
 assert.equal(JSON.stringify(proxied).includes("raw_candidate_must_never_escape"),false);
 assert.equal(ordinary.url,"https://example.org/no-secret");
});
test("trusted SSE receipt records real model-selected tools but never arguments",()=>{
 const event=usageFromSseFrame('event: response.output_item.added\ndata: '+JSON.stringify({
  type:"response.output_item.added",item:{type:"function_call",
   name:"propose_supplier_purchase_order",arguments:"super_private_supplier"}}));
 assert.deepEqual(event,{event:"function_call",name:"propose_supplier_purchase_order"});
 assert.equal(JSON.stringify(event).includes("super_private_supplier"),false);
});
test("trusted host and candidate shim use one canonical ephemeral token name",async()=>{
 const root=mkdtempSync(join(tmpdir(),"task14b-env-broker-"));
 const auditFile=join(root,"audit.json");
 const previous=process.env.AICAFE_14B_BROKER_TOKEN;
 process.env.AICAFE_14B_BROKER_TOKEN="z".repeat(64);
 let server;
 try{
  ({server}=startTrustedBroker({apiKey:key,head,auditFile,port:0,
   fetchUpstream:async()=>{throw Error("no paid transport in env test")}}));
  await once(server,"listening");
  const r=await fetch("http://127.0.0.1:"+server.address().port+"/healthz");
  assert.equal(r.status,200);
  assert.equal(JSON.parse(readFileSync(auditFile,"utf8")).attempts,0);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(previous===undefined)delete process.env.AICAFE_14B_BROKER_TOKEN;
  else process.env.AICAFE_14B_BROKER_TOKEN=previous;
  rmSync(root,{recursive:true,force:true});
 }
});
test("only trusted broker calls real-key transport and never exposes the key",async()=>{
 const root=mkdtempSync(join(tmpdir(),"task14b-host-audit-")),auditFile=join(root,"audit.json");
 let called=0;
 const fetchUpstream=async(url,opts)=>{
  called++;
  assert.equal(url,"https://api.openai.com/v1/responses");
  assert.equal(opts.headers.Authorization,"Bearer "+key);
  const response=JSON.stringify({type:"response.completed",response:{
   model:"gpt-6-luna",service_tier:"default",
   usage:{input_tokens:100,output_tokens:50},
   output:[{type:"function_call",name:"inspect_supplier_purchase",arguments:"private"}]}});
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
  const remote=await fetch(url+"/v1/responses",{
    method:"POST",
    body:JSON.stringify({...params,previous_response_id:"resp_hidden_history"}),
    headers:{authorization:"Bearer "+"z".repeat(64)}});
  assert.equal(remote.status,400);
  assert.equal(called,0,"expanded history may never reach the paid provider");
  assert.equal(JSON.parse(readFileSync(auditFile,"utf8")).attempts,0);
  const permitted=await fetch(url+"/v1/responses",{
    method:"POST",body,headers:{authorization:"Bearer "+"z".repeat(64)}});
  assert.equal(permitted.status,200);
  assert.match(await permitted.text(),/response.completed/);
  assert.equal(called,1);
  const audit=JSON.parse(readFileSync(auditFile,"utf8"));
  assert.equal(audit.attempts,1);
  assert.equal(audit.receipts[0].terminal,"completed");
  assert.equal(audit.receipts[0].actualOutputTokens,50);
  assert.deepEqual(audit.receipts[0].toolNames,["inspect_supplier_purchase"]);
  assert.equal(JSON.stringify(audit).includes(key),false);
  assert.equal(JSON.stringify(audit).includes("secret"),false);
 }finally{await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});}
});
