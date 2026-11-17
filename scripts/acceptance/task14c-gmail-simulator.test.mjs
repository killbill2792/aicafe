import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("./task14c-gmail-simulator.cjs",import.meta.url),"utf8");
function harness(){
 let saved=null,networkCalls=0;
 const fakeFs={
  existsSync:()=>saved!==null,
  readFileSync:()=>saved,
  writeFileSync:(path,content,opts)=>{
   assert.equal(path,"/proof/task14c-simulator-receipt.json");
   assert.equal(opts.flag,"wx");
   if(saved!==null)throw Error("duplicate local write");
   saved=content;
  }
 };
 const ctx={
  process:{env:{AICAFE_14C_SIM_PATH:"/proof/task14c-simulator-receipt.json"}},
  require:(module)=>{assert.equal(module,"node:fs");return fakeFs},
  Response,URL,Request,Buffer,
  globalThis:{fetch:async()=>{networkCalls++;throw Error("real network access denied")}}
 };
 vm.runInNewContext(source,ctx,{filename:"task14c-gmail-simulator.cjs"});
 const send=(raw,token="disposable-task14c-not-a-real-google-token")=>
  ctx.globalThis.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{
   method:"POST",headers:{authorization:"Bearer "+token},body:JSON.stringify({raw})
  });
 const read=()=>ctx.globalThis.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/task14c-disposable-simulated-gmail-message?format=metadata",{
  method:"GET",headers:{authorization:"Bearer disposable-task14c-not-a-real-google-token"}
 });
 return {send,read,getSaved:()=>saved,get networkCalls(){return networkCalls}};
}
function validMime(overrides={}){
 const values={
  From:"owner@task14c.example",To:"orders@task14c.example",
  Subject:"=?UTF-8?B?"+Buffer.from("Purchase order 11111111-1111-4111-8111-111111111111").toString("base64")+"?=",
  "Message-ID":"<aicafe-11111111-1111-4111-8111-111111111111@example.test>",
  ...overrides
 };
 return Buffer.from(Object.entries(values).map(([key,value])=>key+": "+value).join("\r\n")+
   "\r\n\r\n"+Buffer.from("Safe body").toString("base64"),"utf8").toString("base64url");
}
test("Task14C local Gmail simulation verifies one synthetic SENT receipt and refuses a replay",async()=>{
 const h=harness();
 const first=await h.send(validMime());
 assert.equal(first.status,200);
 const created=await first.json();
 assert.equal(created.id,"task14c-disposable-simulated-gmail-message");
 const saved=JSON.parse(h.getSaved());
 assert.equal(saved.count,1);
 assert.equal(saved.acceptedBy,"local_gmail_simulator_not_google");
 assert.equal(saved.subject,"Purchase order 11111111-1111-4111-8111-111111111111");
 const receipt=await (await h.read()).json();
 assert.equal(receipt.payload.headers[0].value,saved.rfc);
 assert.deepEqual(receipt.labelIds,["SENT"]);
 await assert.rejects(()=>h.send(validMime()),/duplicate_send_denied/);
 assert.equal(h.networkCalls,0);
});
test("Task14C transport refuses real OAuth token, other recipient, other sender and forged subject",async()=>{
 for(const [mime,token] of [
  [validMime(),"real-google-token"],
  [validMime({To:"real-supplier@example.net"}),undefined],
  [validMime({From:"other@example.net"}),undefined],
  [validMime({Subject:"not an approved PO"}),undefined]
 ]){
  const h=harness();
  await assert.rejects(()=>h.send(mime,token),/rejects_real_google_credential|rejects_non_disposable_envelope/);
  assert.equal(h.getSaved(),null);
  assert.equal(h.networkCalls,0);
 }
});
test("Task14C transport blocks any other Gmail mutation and cannot use open network",async()=>{
 const h=harness();
 await assert.rejects(()=>h.read(),/read_before_send/);
 await assert.rejects(()=>h.send("not a valid MIME"),/rejects_non_disposable_envelope/);
 assert.equal(h.networkCalls,0);
});
