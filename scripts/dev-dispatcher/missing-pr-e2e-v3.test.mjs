import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalSignature,createDelivery} from './delivery.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {validateHandoff} from './bridge/bridge.mjs';
import {verifiedCodingConversation} from './verified-chat-v3.mjs';
import {nextWake} from './wake.mjs';
import {ensureApprovedDraftPr} from './pr-create-v3.mjs';
import {settings} from './settings.mjs';

const task={id:'E2',state:'ready',title:'Signed early draft',
  goal:'Deliver the approved functionality',
  architecture_approval:{approved:true},depends_on:[],
  edits:['scripts/e2e/smoke.mjs'],acceptance:['Run actual smoke test'],
  brief:'docs/plans/dispatcher-v3-lifecycle-and-rollout.md'};
const hash=approvalSignature(task),head='a'.repeat(40);
const sentAt='2026-11-11T10:00:00Z',conversation='https://chatgpt.com/c/original-e2';
const base={version:1,tasks:{E2:{task_id:'E2',agent:'chatgpt',
  status:'assigned',approved:true,approval_hash:hash,
  branch:'feat/aicafe-task-E2',base_branch:'main',prerequisite_pr:null}},
  actions:{},owner_alerts:{}};
function verifiedInitial(){
 const state=structuredClone(base),record=state.tasks.E2;
 const id='assign:E2';
 const delivery=createDelivery({task,record,action:'assign',actionId:id});
 state.actions[id]={task_id:'E2',type:'assign',status:'planned',delivery_owner:'muse',
   delivery};
 assert.equal(validateHandoff({key:id,...state.actions[id]},record),true);
 const receipt={action_id:id,task_id:'E2',branch:record.branch,
   approval_hash:hash,project_id:settings.chatgpt.project_id,provider:'chatgpt',
   prompt_hash:delivery.prompt_hash,conversation_url:conversation,
   submitted_at:sentAt,status:'submitted'};
 return acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'muse'});
}
function fakeGit({existing=null,failWrite=false,files=['scripts/e2e/smoke.mjs']}={}){
 const calls={reads:[],writes:0};
 const github={request:async path=>{
   calls.reads.push(path);
   if(path.startsWith('/git/ref/heads/'))return {object:{sha:head}};
   if(path.startsWith('/pulls?'))return existing?[existing]:[];
   if(path.startsWith('/compare/'))return {ahead_by:1,files:files.map(filename=>({filename}))};
   throw Error('Unexpected GitHub read '+path);
 }};
 const writer={request:async(path,{body})=>{
   assert.equal(path,'/pulls');
   calls.writes++;
   const data=JSON.parse(body);
   assert.equal(data.draft,true);
   assert.equal(data.base,'main');
   assert.equal(data.head,'feat/aicafe-task-E2');
   if(failWrite)throw Error('GitHub 500: effect result unknown');
   return {state:'open',draft:true,number:450,head:{sha:head}};
 }};
 return {github,writer,calls};
}

test('full signed delivery -> saved original chat -> delayed pre-PR check -> verified draft',async()=>{
 const state=verifiedInitial();
 assert.equal(state.actions['assign:E2'].status,'submitted');
 assert.equal(state.tasks.E2.conversation_ref,conversation);
 assert.equal(verifiedCodingConversation(state,'E2',hash,conversation),true);
 const deadline=Date.parse(sentAt)+15*60*1000;
 const wake=nextWake(state,Date.parse(sentAt));
 assert.equal(wake.reason,'pre_pr_status_check');
 assert.equal(wake.due_at,new Date(deadline).toISOString());
 assert.equal(nextWake(state,deadline+1).key,wake.key);
 const mock=fakeGit();
 const created=await ensureApprovedDraftPr({
   ...mock,task,record:state.tasks.E2,records:state.tasks,
   verifiedDelivery:verifiedCodingConversation(state,'E2',hash,conversation)
 });
 assert.equal(created.status,'created');
 assert.equal(created.pr_number,450);
 assert.equal(mock.calls.writes,1);
 state.tasks.E2.pr_number=created.pr_number;
 state.tasks.E2.github_state='open';
 assert.equal(nextWake(state,deadline+1),null);
 const again=await ensureApprovedDraftPr({...mock,task,record:state.tasks.E2,
   records:state.tasks,verifiedDelivery:true});
 assert.equal(again.status,'already_linked');
 assert.equal(mock.calls.writes,1);
});

test('uncertain GitHub PR create is recovered by read-only PR discovery, not a second POST',async()=>{
 const state=verifiedInitial();
 const first=fakeGit({failWrite:true});
 const uncertain=await ensureApprovedDraftPr({...first,task,record:state.tasks.E2,
   records:state.tasks,verifiedDelivery:true});
 assert.equal(uncertain.status,'uncertain');
 assert.equal(first.calls.writes,1);
 const found=fakeGit({existing:{number:450,state:'open',draft:true,
   head:{ref:'feat/aicafe-task-E2',sha:head}}});
 const discovered=await ensureApprovedDraftPr({...found,task,record:state.tasks.E2,
   records:state.tasks,verifiedDelivery:true});
 assert.equal(discovered.status,'existing_pr_needs_link');
 assert.equal(discovered.pr_number,450);
 assert.equal(found.calls.writes,0);
});

test('one signed original-chat reminder is a continuation and stops when its receipt arrives',()=>{
 let state=verifiedInitial();
 const key='pre_pr_reminder:E2:'+hash;
 const delivery=createDelivery({task,record:state.tasks.E2,
   action:'pre_pr_reminder',actionId:key});
 state.actions[key]={task_id:'E2',type:'pre_pr_reminder',status:'planned',
   delivery_owner:'muse',head_sha:null,delivery};
 assert.equal(delivery.intent,'continue_existing_chat');
 assert.equal(delivery.conversation_url,conversation);
 assert.equal(validateHandoff({key,...state.actions[key]},state.tasks.E2),true);
 state=acceptDeliveryReceipt(state,{action_id:key,task_id:'E2',
   branch:state.tasks.E2.branch,approval_hash:hash,
   project_id:settings.chatgpt.project_id,provider:'chatgpt',
   prompt_hash:delivery.prompt_hash,conversation_url:conversation,
   submitted_at:'2026-11-11T10:16:00Z',status:'submitted'
 },{authenticatedCourier:'muse'});
 assert.equal(state.actions[key].status,'submitted');
 assert.equal(state.tasks.E2.conversation_ref,conversation);
 assert.equal(nextWake(state,Date.parse('2026-11-11T10:17:00Z')),null);
 assert.equal(verifiedCodingConversation(state,'E2',hash,conversation),true);
});

test('unsigned branch changes and unverified delivery cannot produce a PR',async()=>{
 const state=verifiedInitial();
 const mock=fakeGit({files:['scripts/e2e/smoke.mjs','lib/unapproved.ts']});
 const blocked=await ensureApprovedDraftPr({...mock,task,record:state.tasks.E2,
   records:state.tasks,verifiedDelivery:true});
 assert.equal(blocked.reason,'branch_contains_unsigned_edits');
 assert.equal(mock.calls.writes,0);
 const noReceipt=await ensureApprovedDraftPr({...mock,task,record:state.tasks.E2,
   records:state.tasks,verifiedDelivery:false});
 assert.equal(noReceipt.reason,'signed_scope_or_chat_unverified');
 assert.equal(mock.calls.writes,0);
});
