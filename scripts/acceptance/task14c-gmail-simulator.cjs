"use strict";
/**
 * Trusted TEST-ONLY Gmail transport simulator for Task14C's disposable
 * local owner acceptance. No real Google access, accounts or recipient sends.
 * The companion trusted OpenAI broker is installed before this shim.
 */
const {readFileSync,writeFileSync,existsSync}=require("node:fs");
const upstream=globalThis.fetch.bind(globalThis);
const path=process.env.AICAFE_14C_SIM_PATH;
if(path!=="/proof/task14c-simulator-receipt.json")
 throw Error("task14c_local_sim_path_required");
const fakeId="task14c-disposable-simulated-gmail-message";
const json=(value)=>new Response(JSON.stringify(value),{
 status:200,headers:{"content-type":"application/json"}});
globalThis.fetch=async function task14cGmailSimulator(input,init){
 const url=typeof input==="string"?input:
  input instanceof URL?input.toString():input?.url;
 if(typeof url!=="string")return upstream(input,init);
 let target;try{target=new URL(url)}catch{return upstream(input,init)}
 if(target.hostname!=="gmail.googleapis.com")return upstream(input,init);
 if(target.origin!=="https://gmail.googleapis.com"||
    !target.pathname.startsWith("/gmail/v1/users/me/"))
  throw Error("task14c_simulator_rejects_noncanonical_google_url");
 const base=input instanceof Request?input:null;
 const method=(init?.method??base?.method??"GET").toUpperCase();
 const token=init?.headers?.authorization??base?.headers?.get("authorization");
 if(token!=="Bearer disposable-task14c-not-a-real-google-token")
  throw Error("task14c_simulator_rejects_real_google_credential");
 if(method==="GET"&&target.pathname==="/gmail/v1/users/me/messages")
  return json({messages:[],resultSizeEstimate:0});
 if(method==="POST"&&target.pathname==="/gmail/v1/users/me/messages/send"){
  if(existsSync(path))throw Error("task14c_simulator_duplicate_send_denied");
  const payload=JSON.parse(String(init?.body??"{}"));
  if(typeof payload.raw!=="string"||payload.raw.length>30000)
   throw Error("task14c_simulator_invalid_mime");
  const mime=Buffer.from(payload.raw,"base64url").toString("utf8");
  const field=(name)=>mime.match(new RegExp("^"+name+":\s*(.+)$","im"))?.[1]?.trim();
  const to=field("To"),from=field("From"),subject=field("Subject"),rfc=field("Message-ID");
  if(to!=="orders@task14c.example"||
    from!=="owner@task14c.example"||
    !/^Purchase order [0-9a-f-]{36}$/i.test(subject??"")||
    !/^<[^<>\\r\\n]{1,240}>$/.test(rfc??""))
   throw Error("task14c_simulator_rejects_non_disposable_envelope");
  writeFileSync(path,JSON.stringify({id:fakeId,rfc,subject,
   acceptedBy:"local_gmail_simulator_not_google",count:1})+"\n",{flag:"wx",mode:0o600});
  return json({id:fakeId,threadId:"task14c-disposable-thread"});
 }
 if(method==="GET"&&target.pathname==="/gmail/v1/users/me/messages/"+fakeId){
  if(!existsSync(path))throw Error("task14c_simulator_read_before_send");
  const saved=JSON.parse(readFileSync(path,"utf8"));
  return json({id:fakeId,threadId:"task14c-disposable-thread",
    labelIds:["SENT"],payload:{headers:[{name:"Message-ID",value:saved.rfc}]}});
 }
 throw Error("task14c_simulator_blocks_other_gmail_effect");
};