import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactPrivateLedger} from './ledger-compaction.mjs';
import {queueOwnerAlerts} from './alerts.mjs';

const now='2026-11-12T00:50:00.000Z';
const old='2026-11-11T20:00:00.000Z';
const current='2026-11-12T00:48:00.000Z';
const fixture=()=>{
 const alerts={};
 for(let i=0;i<100;i++)alerts['notice:old'+i]={
   kind:'dispatcher_emergency',identity:'run:'+i+':failure',notice_hash:'old'+i,
   status:i%2?'resolved':'cancelled_no_longer_needed',created_at:old,
   question:'historical question '+'.'.repeat(700),owner_message:'old owner message '+'.'.repeat(700),
   recipient:'owner',delivery_owner:'muse'};
 for(let i=0;i<70;i++)alerts['notice:live'+i]={
   kind:'owner_decision',task_id:'T',notice_hash:'live'+i,status:'planned',
   created_at:current,question:'NEVER ARCHIVE PENDING '+'.'.repeat(700)};
 const history={};
 for(let i=0;i<550;i++)history['wake'+i]={
   status:'requested',requested_at:i<545?old:current,
   key:'wake'+i,reason:'owner_notice_retry',
   context:'.'.repeat(140)};
 return {version:1,updated_at:current,tasks:{T:{approved:true}},
   actions:{original:{status:'planned',delivery:{prompt:'protected signed instruction'}}},
   owner_alerts:alerts,delayed_wake_history:history,
   lifecycle_v3:{version:3,transitions:Array.from({length:90},(_,i)=>({at:old,
     task_id:'T',from:{stage:'APPROVED'},to:{stage:'VERIFYING'}})),
     latest:{T:{}},rows:{T:{current_stage:'VERIFYING'}}}};
};

test('oversized private ledger archives old history without touching active events',()=>{
 const original=fixture(),before=JSON.stringify(original),res=compactPrivateLedger(original,{now,targetBytes:100_000});
 assert.ok(res.before_bytes>200_000);
 assert.ok(res.after_bytes<res.before_bytes-150_000);
 assert.equal(JSON.stringify(original),before,'source unchanged');
 assert.equal(res.state.actions.original.delivery.prompt,'protected signed instruction');
 assert.equal(Object.values(res.state.owner_alerts).filter(x=>x.status==='planned').length,70);
 assert.equal(Object.keys(res.archive&&JSON.parse(res.archive.content).owner_alerts).length,100);
 assert.equal(Object.keys(res.archive&&JSON.parse(res.archive.content).delayed_wake_history).length,545);
 assert.equal(res.state.delayed_wake_history.wake549.requested_at,current);
 assert.equal(res.state.owner_alerts['notice:old1'].status,'resolved');
 assert.equal(res.state.owner_alerts['notice:old1'].identity,'run:1:failure');
 assert.equal(res.state.owner_alerts['notice:old1'].question,undefined);
 assert.equal(res.state.lifecycle_v3.transitions.length,25);
 const archived=JSON.parse(res.archive.content);
 assert.equal(archived.lifecycle_transitions.length,65);
 assert.equal(res.archive.sha256,createHash('sha256').update(res.archive.content).digest('hex'));
 assert.equal(res.state.ledger_archives[0].path,res.archive.path);
 assert.ok(res.archive.path.startsWith('dispatcher/archives/'));
});
test('small private ledger remains unchanged, produces no archive',()=>{
 const s={version:1,tasks:{},actions:{},owner_alerts:{}};
 const r=compactPrivateLedger(s,{now});
 assert.equal(r.state,s);
 assert.equal(r.archive,null);
});
test('never archive unconfirmed or submitted owner receipts',()=>{
 const s={version:1,tasks:{},actions:{},owner_alerts:{
   pending:{kind:'notice',status:'claimed',question:'pending '.repeat(300)},
   submitted:{kind:'notice',status:'submitted',receipt:{courier:'muse'},
     question:'receipt '.repeat(300)}}};
 const r=compactPrivateLedger(s,{now,targetBytes:100_000});
 assert.equal(r.archive,null);
 assert.equal(r.state.owner_alerts.submitted.receipt.courier,'muse');
});
test('reject unsafe compaction config, preserve unknown history',()=>{
 assert.throws(()=>compactPrivateLedger(fixture(),{now:'bad'}),/Invalid/);
 const s={version:1,tasks:{},actions:{},delayed_wake_history:{
   unknown:{status:'reserved',reserved_at:'invalid'}}};
 const r=compactPrivateLedger(s,{now,targetBytes:100_000});
 assert.equal(r.state.delayed_wake_history.unknown.status,'reserved');
});

test('withdrawn owner question safely reactivates after private history compaction',()=>{
 const initial={version:1,tasks:{T:{task_id:'T',pr_number:444,
   owner_question:'Please review exact signed question'}},
   actions:{large:{status:'submitted',metadata:'x'.repeat(102_000)}},owner_alerts:{}};
 const queue={tasks:[]};
 const queued=queueOwnerAlerts(initial,{queue,openPrs:[]});
 const key=Object.keys(queued.owner_alerts).find(k=>queued.owner_alerts[k].kind==='owner_decision');
 assert.ok(key);
 const withdrawn=queueOwnerAlerts({...queued,tasks:{T:{...queued.tasks.T,owner_question:null}}},
   {queue,openPrs:[]});
 assert.equal(withdrawn.owner_alerts[key].status,'cancelled_no_longer_needed');
 const compacted=compactPrivateLedger(withdrawn,{now,targetBytes:100_000});
 assert.ok(compacted.archive);
 assert.equal(compacted.state.owner_alerts[key].question,undefined);
 const restored=queueOwnerAlerts({...compacted.state,
   tasks:{T:{...queued.tasks.T,owner_question:'Please review exact signed question'}}},
   {queue,openPrs:[]});
 const notice=restored.owner_alerts[key];
 assert.equal(notice.status,'planned');
 assert.equal(notice.delivery_owner,'muse');
 assert.equal(notice.recipient,'owner');
 assert.match(notice.question,/Please review exact signed question/);
 assert.match(notice.owner_message,/Please review exact signed question/);
 assert.equal(notice.notice_hash,queued.owner_alerts[key].notice_hash);
});
