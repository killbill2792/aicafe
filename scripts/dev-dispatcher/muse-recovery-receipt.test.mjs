import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {recoveryIdentity} from './recovery-v3.mjs';
import {receiptFilename} from './receipt-identity.mjs';
import {applyReceipts,inspectReceipts,applyReceiptsSafely} from './inbox.mjs';
import {museRecoveryReceipt,validateMuseRecoveryReceipt,pushMuseRecoveryReceipt}
  from './muse-recovery-receipt.mjs';

const repo='killbill2792/aicafe',actor='killbill2792',
  SHA='a'.repeat(40),oldHead='b'.repeat(40);
function request(values={}){
 const base={version:1,repo,actor,intent:'RECONCILE',
   task_id:null,pr_number:null,expected_head_sha:null,
   requested_at:new Date().toISOString(),...values};
 return {...base,request_id:recoveryIdentity(base)};
}
const baseState=()=>({version:1,tasks:{'10':{
 pr_number:443,head_sha:SHA,github_state:'open',approved:true}},actions:{}});
const actors={[actor]:'muse'};
function git(args,cwd){
 const r=spawnSync('git',args,{cwd,encoding:'utf8'});
 if(r.status!==0)throw Error('fixture Git failed '+args[0]+': '+r.stderr);
 return r.stdout.trim();
}
test('HMAC-free Muse receipt preserves exact v3 recovery identity and 64-hex filename',()=>{
 const r=request(),receipt=museRecoveryReceipt(r,{actor});
 assert.equal(receipt.request_id,r.request_id);
 assert.equal(receipt.event_id,r.request_id);
 assert.equal(receipt.kind,'muse_recovery');
 assert.match(receiptFilename(receipt),/^[a-f0-9]{64}\.json$/);
 assert.deepEqual(validateMuseRecoveryReceipt(receipt,{actor,actors}),receipt);
});
test('verified Muse commit can request global reconciliation; no scope or CI facts change',()=>{
 const receipt=museRecoveryReceipt(request(),{actor}),s=baseState();
 const applied=applyReceipts(s,[{receipt,actor}],actors);
 assert.equal(applied.recovery_requests[receipt.request_id].intent,'RECONCILE');
 assert.equal(applied.recovery_requests[receipt.request_id].status,'PENDING');
 assert.equal(applied.muse_recovery_events[receipt.event_id].status,'REQUESTED');
 assert.deepEqual(applied.tasks,s.tasks);
 assert.deepEqual(applied.actions,s.actions);
 const twice=applyReceipts(applied,[{receipt,actor}],actors);
 assert.deepEqual(twice,applied);
});
test('unverified actor, forged owner and tampered command all fail closed',()=>{
 const good=museRecoveryReceipt(request(),{actor});
 const wrong=[{actor:'attacker',payload:good,actors:{attacker:'muse'}},
  {actor, payload:{...good,actor:'attacker'}, actors},
  {actor,payload:{...good,project_id:'other'},actors},
  {actor,payload:{...good,intent:'MERGE_IF_ELIGIBLE'},actors},
  {actor,payload:{...good,event_id:'f'.repeat(64)},actors},
  {actor,payload:{...good,submitted_at:'1999-01-01T00:00:00.000Z'},actors}
 ];
 for(const item of wrong)
   assert.throws(()=>validateMuseRecoveryReceipt(item.payload,{
    actor:item.actor,actors:item.actors}));
 for(const bad of [{receipt:good,actor:'attacker'},
   {receipt:good,actor:'someone-else'}])
   assert.deepEqual(applyReceipts(baseState(),[bad],actors),baseState(),
    'unknown Git commit actor must be ignored with no ledger effect');
});
test('scoped request needs exact verified task PR and SHA and cannot add merge evidence',()=>{
 const original=request({intent:'REQUEST_CODEX_IF_ELIGIBLE',
   task_id:'10',pr_number:443,expected_head_sha:SHA});
 const receipt=museRecoveryReceipt(original,{actor});
 const s=baseState(),updated=applyReceipts(s,[{receipt,actor}],actors);
 assert.equal(updated.muse_recovery_events[receipt.event_id].status,'REQUESTED');
 assert.equal(updated.recovery_requests[receipt.request_id].status,'PENDING');
 assert.equal(updated.tasks['10'].merge_sha,undefined);
 assert.equal(updated.tasks['10'].codex_state,undefined);
 const changed=baseState();changed.tasks['10'].head_sha=oldHead;
 const blocked=applyReceipts(changed,[{receipt,actor}],actors);
 assert.equal(blocked.muse_recovery_events[receipt.event_id].status,'BLOCKED');
 assert.equal(blocked.recovery_rejections[receipt.request_id].reason,'stale_head');
 assert.deepEqual(blocked.tasks,changed.tasks);
});
test('unsupported operations, malformed scope and caller-supplied identity are rejected',()=>{
 assert.throws(()=>museRecoveryReceipt(request({intent:'FORCE_MERGE'}),{actor}));
 assert.throws(()=>museRecoveryReceipt(request({intent:'RETRY_CI_IF_SAFE'}),{actor}));
 assert.throws(()=>museRecoveryReceipt(request({actor:'forged'}),{actor}));
 const scoped=request({intent:'CHECK_STALL',task_id:'10',
   pr_number:443,expected_head_sha:SHA});
 assert.throws(()=>museRecoveryReceipt({...scoped,request_id:'1'.repeat(64)},{actor}));
 assert.throws(()=>museRecoveryReceipt(request(),{actor:'wrong actor'}));
});
test('private Git receipt transport persists without GitHub REST and retry is idempotent',()=>{
 const root=mkdtempSync(join(tmpdir(),'muse-bridge-test-'));
 try{
  const bare=join(root,'bare.git'),seed=join(root,'seed'),read=join(root,'read');
  git(['init','-q','--bare','-b','main',bare],root);
  git(['clone','-q',bare,seed],root);
  git(['config','user.email','fixture@example.com'],seed);
  git(['config','user.name','Fixture'],seed);
  mkdirSync(join(seed,'dispatcher'),{recursive:true});
  writeFileSync(join(seed,'dispatcher','state.json'),
    JSON.stringify(baseState())+'\n');
  git(['add','.'],seed);git(['commit','-qm','seed'],seed);
  git(['push','-q','origin','HEAD:main'],seed);
  const req=request(),args={request:req,actor,
   token:'test-private-git-credential',remoteUrl:bare,authorEmail:'fixture@example.com'};
  const first=pushMuseRecoveryReceipt(args);
  const again=pushMuseRecoveryReceipt(args);
  assert.equal(first.status,'queued');
  assert.equal(again.status,'already_queued');
  assert.equal(first.request_id,req.request_id);
  git(['clone','-q',bare,read],root);
  const receipt=JSON.parse(readFileSync(join(read,first.file),'utf8'));
  assert.equal(receipt.kind,'muse_recovery');
  assert.equal(receipt.request_id,req.request_id);
  const history=Number(git(['rev-list','--count','HEAD'],read));
  assert.equal(history,2,'retry did not create a second commit');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('authenticated GitHub commit actor is checked before Muse recovery receipt ingestion',async()=>{
 const receipt=museRecoveryReceipt(request(),{actor});
 const filename=receiptFilename(receipt),path='dispatcher/receipts/'+filename;
 const fakeLedger=commitActor=>({request:async endpoint=>{
   if(endpoint==='/contents/dispatcher/receipts?ref=main')
     return [{type:'file',name:filename,path,sha:'f'.repeat(40)}];
   if(endpoint==='/commits?path='+encodeURIComponent(path)+'&per_page=1')
     return [{author:{login:commitActor}}];
   if(endpoint==='/contents/'+path+'?ref=main')
     return {content:Buffer.from(JSON.stringify(receipt)).toString('base64')};
   throw Error('unexpected GitHub read '+endpoint);
 }});
 const accepted=await inspectReceipts({ledger:fakeLedger(actor),allowedActors:[actor]});
 assert.equal(accepted.complete,true);
 assert.equal(accepted.accepted.length,1);
 assert.equal(accepted.accepted[0].actor,actor);
 const applied=applyReceiptsSafely(baseState(),accepted.accepted,actors);
 assert.equal(applied.state.recovery_requests[receipt.request_id].status,'PENDING');
 const forged=await inspectReceipts({ledger:fakeLedger('attacker'),allowedActors:[actor]});
 assert.equal(forged.accepted.length,0);
 assert.equal(forged.rejected[0].code,'unapproved_git_actor');
 assert.deepEqual(applyReceiptsSafely(baseState(),forged.accepted,actors).state,baseState());
});
