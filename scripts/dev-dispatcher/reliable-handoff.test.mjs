import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {approvalSignature,createDelivery} from './delivery.mjs';
import {queueOwnerAlerts,noticeHash,applyOwnerStartApprovals,
  wakePendingOwnerNotices} from './alerts.mjs';
import {applyReceiptsSafely,inspectReceipts} from './inbox.mjs';
import {revalidateQueuedActions,assignmentActionKey} from './authorization.mjs';
import {dispatchFrontier} from './core.mjs';
import {signalFor} from './signal.mjs';
import {receiptFilename} from './receipt-identity.mjs';
import {nextWake} from './wake.mjs';

const queue=JSON.parse(readFileSync(new URL('../../docs/plans/universal-supervisor-queue.json',import.meta.url),'utf8'));
const task=queue.tasks.find(t=>t.id==='6'),hash=approvalSignature(task);
const noticeId='notice:'+noticeHash({kind:'next_task_start',task_id:'6',source_sha:hash});
const at='2026-11-11T01:06:26Z',now=Date.parse(at);
function incident(){
 return {version:1,tasks:{
  '5':{status:'integrated_proven',pr_number:378},
  POS0f:{status:'integrated_proven',pr_number:422},
  '6':{task_id:'6',status:'blocked_needs_owner',agent:'chatgpt',approved:false,
    approval_hash:hash,priority_deferred:true,prompt_id:'task:6',prompt_version:'v1'}
 },actions:{'assign:6':{task_id:'6',type:'assign',status:'cancelled_approval_changed',
   delivery:{approval_hash:'1d589b797fd89eace71b5a2d69ffdc659e4f1c23aa59ae1c94d92874e6f03395'}
 }},owner_alerts:{}};
}
const reply={kind:'owner_reply',event_id:'owner-yes-task6-179d36da',
  target:{task_id:'6',notice_id:noticeId},text:'yes',submitted_at:at};
const actorMap={'muse-app[bot]':'muse'};
test('real task-6 state moves from authenticated yes to one newly signed unsent assignment',()=>{
 const s=queueOwnerAlerts(incident(),{queue,now:at});
 assert.equal(s.owner_alerts[noticeId].status,'planned');
 const inb=applyReceiptsSafely(s,[{receipt:reply,actor:'muse-app[bot]'}],actorMap);
 assert.deepEqual(inb.rejected,[]);
 const approved=applyOwnerStartApprovals(inb.state,queue);
 assert.equal(approved.owner_alerts[noticeId].status,'submitted');
 assert.equal(approved.owner_alerts[noticeId].receipt.source,'authenticated_owner_reply');
 assert.equal(approved.tasks['6'].status,'proposed');
 assert.equal(approved.tasks['6'].approved,true);
 revalidateQueuedActions(approved,new Map(queue.tasks.map(t=>[t.id,t])),queue);
 assert.equal(approved.tasks['6'].approved,true);
 assert.ok(dispatchFrontier(queue,approved.tasks).some(t=>t.task_id==='6'));
 const key=assignmentActionKey(approved,'6',queue);
 assert.equal(key,'assign:6:approval-'+hash);
 const record={...approved.tasks['6'],agent:'chatgpt',approved:true,branch:'feat/aicafe-task-6',
  base_branch:'main',status:'assigned',prompt_version:'v2'};
 const delivery=createDelivery({task,record,action:'assign',actionId:key});
 assert.equal(delivery.approval_hash,hash);
 approved.actions[key]={type:'assign',task_id:'6',status:'planned',
   delivery_owner:'muse',created_at:at,delivery};
 approved.tasks['6']=record;
 assert.equal(assignmentActionKey(approved,'6',queue),null);
 assert.equal(Object.values(approved.actions).filter(a=>a.status==='planned'&&a.task_id==='6').length,1);
 assert.equal(signalFor(approved,'s'.repeat(64)).pending_count,1);
 const again=applyOwnerStartApprovals(approved,queue);
 assert.equal(again.owner_alerts[noticeId].status,'submitted');
 assert.equal(Object.keys(again.actions).length,2);
});
test('reissued task cannot duplicate claimed, uncertain, submitted or received browser work',()=>{
 for(const field of ['delivery_claim','claimed_at','submitted_at','receipt']){
  const s=incident();s.tasks['6']={...s.tasks['6'],approved:true,status:'proposed'};
  s.actions['assign:6'][field]=field==='receipt'?{}:'2026-11-11T01:05:00Z';
  assert.equal(assignmentActionKey(s,'6',queue),null,field);
 }
 for(const status of ['planned','claimed','uncertain','submitted','needs_login']){
  const s=incident();s.tasks['6']={...s.tasks['6'],approved:true,status:'proposed'};
  s.actions['assign:6'].status=status;
  assert.equal(assignmentActionKey(s,'6',queue),null,status);
 }
});
test('new signature, outdated notice, wrong target and withdrawn scope never approve',()=>{
 const s=queueOwnerAlerts(incident(),{queue,now:at});
 const other={...task,goal:'changed owner scope'};
 const changed={...queue,tasks:queue.tasks.map(t=>t.id==='6'?other:t)};
 const yes=applyReceiptsSafely(s,[{receipt:reply,actor:'muse-app[bot]'}],actorMap).state;
 assert.equal(applyOwnerStartApprovals(yes,changed).tasks['6'].approved,false);
 const wrong={...reply,target:{task_id:'6',notice_id:'notice:wrong'}};
 const no=applyReceiptsSafely(s,[{receipt:wrong,actor:'muse-app[bot]'}],actorMap).state;
 assert.equal(applyOwnerStartApprovals(no,queue).tasks['6'].approved,false);
 const old=incident();old.tasks['6'].approved=true;old.tasks['6'].status='proposed';
 revalidateQueuedActions(old,new Map([['6',other]]),queue);
 assert.equal(old.tasks['6'].approved,false);
 assert.equal(assignmentActionKey(old,'6',queue),null);
});
test('receipt v1 filename is identical for Muse CLI and GitHub inbox',async()=>{
 const acknowledgement={kind:'owner_notice',notice_id:noticeId,
  notice_hash:noticeId.slice('notice:'.length),status:'submitted',submitted_at:at};
 assert.equal(receiptFilename(acknowledgement),
  '5d5cacfe23cb549e5e31118a68016493fca0a3d9e0584c4533e69a5427c8c904.json');
 assert.equal(receiptFilename(reply),
  'fcdc3004781187225b23ed3e5818823acabe41f53f23ebba630434a09c46eb66.json');
 const good=receiptFilename(acknowledgement),bad='0'.repeat(64)+'.json';
 const files=[good,bad].map(name=>({type:'file',name,path:'dispatcher/receipts/'+name}));
 const ledger={request:async path=>{
  if(path.includes('/commits?path='))return [{author:{login:'muse-app[bot]'}}];
  if(path.endsWith('/receipts?ref=main'))return files;
  return {content:Buffer.from(JSON.stringify(acknowledgement)).toString('base64')};
 }};
 const scan=await inspectReceipts({ledger,allowedActors:['muse-app[bot]']});
 assert.equal(scan.complete,true);
 assert.equal(scan.accepted.length,1);
 assert.deepEqual(scan.rejected,[{file:bad,code:'invalid_receipt_identity'}]);
});
test('owner-notice retry changes opaque signal and overdue wake stays recoverable',()=>{
 const s=queueOwnerAlerts(incident(),{queue,now:at}),secret='a'.repeat(64);
 const first=signalFor(s,secret),before=nextWake(s,now,{...queue,repo:'killbill2792/aicafe',muse:{retry_seconds:900}});
 assert.equal(before.reason,'owner_notice_retry');
 assert.equal(before.due_at,new Date(now+900000).toISOString());
 wakePendingOwnerNotices(s,now+900000);
 assert.equal(s.owner_alerts[noticeId].wake_round,1);
 const next=signalFor(s,secret);
 assert.notEqual(first.fingerprint,next.fingerprint);
 const late=nextWake(s,now+2700000,{repo:'killbill2792/aicafe',muse:{retry_seconds:900},codex:{settle_seconds:300}});
 assert.equal(late.reason,'owner_notice_retry');
 assert.equal(late.due_at,new Date(now+2700000+5000).toISOString());
});
