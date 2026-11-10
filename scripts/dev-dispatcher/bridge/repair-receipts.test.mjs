import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reattestMuseReceipts} from './repair-receipts.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const prompt='Approved original coding instruction';
const hash=sha(prompt),approval='a'.repeat(64),actionId='assign:POS0e';
const chat='https://chatgpt.com/g/g-p-test-ai-cafe/c/6af1c30f-c5b8-83e9-97cf-18a6c0ee3f5e';
const delivery={action_id:actionId,task_id:'POS0e',prompt,prompt_hash:hash,
  approval_hash:approval,project:{id:'aicafe'},provider:'chatgpt',intent:'start_new_chat'};
const action={task_id:'POS0e',type:'assign',status:'cancelled_stale_head',delivery_owner:'muse',delivery};
const receipt={action_id:actionId,task_id:'POS0e',prompt_hash:hash,approval_hash:approval,
  project:{id:'aicafe'},provider:'chatgpt',intent:'start_new_chat',conversation_url:chat};
const state={version:1,tasks:{POS0e:{approved:true,github_state:'open',pr_number:404,approval_hash:approval}},
  actions:{[actionId]:action},receipt_feedback:{[actionId]:{task_id:'POS0e',status:'rejected',
   code:'unattributed_git_actor'}}};
const basePath='/repos/killbill2792/dave-task-queue';
const target='dispatcher/receipts/'+sha(actionId+':'+hash)+'.json';
function mock({invalidActor=false,receiptOverride={},taskOverride={},customMeta=false}={}){
 const writes=[];
 const stateData=structuredClone(state);
 Object.assign(stateData.tasks.POS0e,taskOverride);
 const current={...receipt,...receiptOverride};
 const calls=[];
 const fetchFn=async(url,options={})=>{
  const path=url.replace('https://api.github.com','');calls.push({path,method:options.method||'GET'});
  let body;
  if(path==='/user')body={login:'owner-login'};
  else if(path===basePath)body={private:true};
  else if(path===basePath+'/contents/dispatcher/state.json?ref=main')
    body={content:Buffer.from(JSON.stringify(stateData)).toString('base64')};
  else if(path===basePath+'/contents/'+target+'?ref=main')
    body={sha:'existing-blob',content:Buffer.from(JSON.stringify(current)).toString('base64')};
  else if(path.startsWith(basePath+'/commits?')){
    body=[{author:{login:writes.length&& !invalidActor?'owner-login':null},commit:{message:'original',committer:{date:'2026-11-09T19:00:00Z'}}}];
  }else if(path===basePath+'/contents/'+target&&options.method==='PUT'){
    const data=JSON.parse(options.body);writes.push(data);body={commit:{sha:'new-commit'}};
  }else throw Error('Unexpected '+path);
  return {ok:true,json:async()=>body};
 };
 return {fetchFn,calls,writes};
}
test('existing Muse uses authenticated private GitHub API to re-attest SAME receipt without browser calls',async()=>{
 const env=mock();
 const result=await reattestMuseReceipts({repo:'killbill2792/dave-task-queue',token:'test-token',
  fetchFn:env.fetchFn,now:'2026-11-09T20:00:00Z',configuredActors:{'owner-login':'muse'}});
 assert.equal(result.results[0].status,'reattributed_waiting_for_dispatcher');
 assert.equal(env.writes.length,1);
 assert.equal(env.writes[0].sha,'existing-blob');
 assert.equal(env.writes[0].author,undefined);
 assert.equal(env.writes[0].committer,undefined);
 const saved=JSON.parse(Buffer.from(env.writes[0].content,'base64').toString('utf8'));
 assert.equal(saved.conversation_url,chat);
 assert.equal(saved.action_id,actionId);
 assert.equal(saved.prompt_hash,hash);
 assert.equal(saved.approval_hash,approval);
 assert.equal(env.calls.filter(c=>c.method==='PUT').length,1);
 assert.equal(env.calls.some(c=>/browser|chatgpt|openclaw/.test(c.path)),false);
});
test('wrong courier GitHub identity fails closed before touching receipt',async()=>{
 const env=mock();
 await assert.rejects(reattestMuseReceipts({repo:'killbill2792/dave-task-queue',
  token:'token',fetchFn:env.fetchFn,configuredActors:{other:'muse'}}),/not mapped/);
 assert.equal(env.writes.length,0);
});
test('wrong original chat or already closed/approved action is never rewritten',async()=>{
 const bad=mock({receiptOverride:{conversation_url:'https://evil.example/x'}});
 const first=await reattestMuseReceipts({repo:'killbill2792/dave-task-queue',
  token:'token',fetchFn:bad.fetchFn});
 assert.equal(first.results[0].status,'receipt_validation_failed');
 assert.equal(bad.writes.length,0);
 const closed=mock({taskOverride:{github_state:'merged'}});
 const second=await reattestMuseReceipts({repo:'killbill2792/dave-task-queue',
  token:'token',fetchFn:closed.fetchFn});
 assert.equal(second.results[0].status,'ineligible');
 assert.equal(closed.writes.length,0);
});
test('unrecognized author after API re-commit stays unacknowledged',async()=>{
 const env=mock({invalidActor:true});
 const r=await reattestMuseReceipts({repo:'killbill2792/dave-task-queue',
  token:'token',fetchFn:env.fetchFn});
 assert.equal(r.results[0].status,'git_actor_still_unattributed');
 assert.equal(env.writes.length,1);
});
