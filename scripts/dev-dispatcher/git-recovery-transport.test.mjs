import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {recoveryIdentity} from './recovery-v3.mjs';
import {transactLedgerViaGit} from './git-operations.mjs';
import {signMuseGitRecovery,verifyMuseGitRecovery,
  scanMuseGitRecoveryDirectory,fetchMuseGitRecoveries,pushMuseGitRecovery}
  from './git-recovery-transport.mjs';

const secret='a truly private independent thirty-two-byte Muse recovery signing secret';
const repo='killbill2792/aicafe',actor='killbill2792',now='2026-11-11T10:01:00.000Z';
const actors={[actor]:'muse'},SHA='a'.repeat(40);
const signed=(override={})=>{
 const cmd={version:1,repo,actor,intent:'RECONCILE',task_id:null,pr_number:null,
  expected_head_sha:null,requested_at:'2026-11-11T10:00:00.000Z',...override};
 return {...cmd,request_id:recoveryIdentity(cmd)};
};
function fixture(fn){
 const root=mkdtempSync(join(tmpdir(),'aicafe-git-recovery-test-'));
 try{return fn(root);}finally{rmSync(root,{recursive:true,force:true});}
}
function git(args,cwd){
 const r=spawnSync('git',args,{cwd,encoding:'utf8'});
 if(r.status!==0)throw Error('Git fixture failed: '+args[0]+' '+(r.stderr||'').slice(0,150));
 return r.stdout.trim();
}
test('signed Git recovery command verifies actor, identity, freshness and MAC',()=>{
 const req=signed();
 const envelope=signMuseGitRecovery(req,secret);
 assert.equal(verifyMuseGitRecovery(envelope,{secret,actors,now}).request_id,req.request_id);
 for(const bad of [
  {...envelope,signature:'f'.repeat(64)},
  {...envelope,request:{...req,task_id:'10'}},
  {...envelope,request:{...req,actor:'forged'}},
 ]){
  assert.throws(()=>verifyMuseGitRecovery(bad,{secret,actors,now}));
 }
 assert.throws(()=>verifyMuseGitRecovery(envelope,{secret,actors:{},now}),/Unauthorized/);
 assert.throws(()=>signMuseGitRecovery(req,'short'),/configured securely/);
 assert.throws(()=>signMuseGitRecovery({...req,intent:'FORCE_MERGE'},secret));
});
test('signed request survives 10-minute workflow cancellation; rejects expired backlog',()=>{
 const envelope=signMuseGitRecovery(signed(),secret);
 assert.equal(verifyMuseGitRecovery(envelope,{secret,actors,
  now:'2026-11-11T12:00:00Z'}).intent,'RECONCILE');
 assert.throws(()=>verifyMuseGitRecovery(envelope,{secret,actors,
  now:'2026-11-19T12:00:00Z'}),/Expired/);
});
test('scoped unsafe commands require exact task PR and SHA before signing',()=>{
 assert.throws(()=>signMuseGitRecovery(signed({intent:'MERGE_IF_ELIGIBLE'}),secret));
 const p=signed({intent:'MERGE_IF_ELIGIBLE',task_id:'10',pr_number:443,
  expected_head_sha:SHA});
 assert.equal(signMuseGitRecovery(p,secret).request.intent,'MERGE_IF_ELIGIBLE');
});
test('Git inbox rejects tampered, overlong and unrelated files without skipping valid',()=>{
 fixture(root=>{
  const dir=join(root,'dispatcher','recovery-requests');
  mkdirSync(dir,{recursive:true});
  const valid=signMuseGitRecovery(signed(),secret);
  writeFileSync(join(dir,valid.request.request_id+'.json'),JSON.stringify(valid));
  writeFileSync(join(dir,'invalid.json'),'{}');
  writeFileSync(join(dir,'f'.repeat(64)+'.json'),JSON.stringify({
   ...valid,signature:'f'.repeat(64)}));
  const scan=scanMuseGitRecoveryDirectory(root,{secret,actors,now});
  assert.equal(scan.accepted.length,1);
  assert.equal(scan.accepted[0].request.intent,'RECONCILE');
  assert.equal(scan.rejected.length,2);
  assert.equal(scan.complete,false);
  const dedup=scanMuseGitRecoveryDirectory(root,{secret,actors,now,
    processed:{[valid.request.request_id+'.json']:'observed'}});
  assert.equal(dedup.accepted.length,0);
 });
});
test('Git-only Muse push/read persists command idempotently without GitHub REST',()=>{
 fixture(root=>{
  const bare=join(root,'bare.git'),seed=join(root,'seed');
  git(['init','-q','--bare','-b','main',bare],root);
  git(['clone','-q',bare,seed],root);
  git(['config','user.email','test@example.com'],seed);
  git(['config','user.name','Offline CI Fixture'],seed);
  mkdirSync(join(seed,'dispatcher'),{recursive:true});
  writeFileSync(join(seed,'dispatcher','state.json'),
    '{"version":1,"tasks":{},"actions":{}}\n');
  git(['add','.'],seed);git(['commit','-qm','seed private test repo'],seed);
  git(['push','-q','origin','HEAD:main'],seed);
  const args={request:signed(),secret,token:'fixture-git-token',remoteUrl:bare};
  const first=pushMuseGitRecovery(args);
  const again=pushMuseGitRecovery(args);
  assert.equal(first.status,'queued');
  assert.equal(again.status,'already_queued');
  const scan=fetchMuseGitRecoveries({token:'fixture-git-token',secret,
   actors,remoteUrl:bare,now});
  assert.equal(scan.accepted.length,1);
  assert.equal(scan.accepted[0].request.request_id,args.request.request_id);
  assert.equal(scan.rejected.length,0);
  const reader=join(root,'reader');
  git(['clone','-q',bare,reader],root);
  const stored=JSON.parse(readFileSync(join(reader,first.file),'utf8'));
  assert.equal(stored.request.request_id,args.request.request_id);
 });
});

test('trusted ledger Git-CAS atomically consumes acknowledged command, preserving Git audit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aicafe-git-cas-'));
 try{
  const bare=join(root,'bare.git'),seed=join(root,'seed'),reader=join(root,'reader');
  git(['init','-q','--bare','-b','main',bare],root);
  git(['clone','-q',bare,seed],root);
  git(['config','user.email','test@example.com'],seed);
  git(['config','user.name','Offline CI Fixture'],seed);
  mkdirSync(join(seed,'dispatcher'),{recursive:true});
  writeFileSync(join(seed,'dispatcher','state.json'),
   '{"version":1,"tasks":{},"actions":{},"owner_alerts":{}}\n');
  git(['add','.'],seed);git(['commit','-qm','seed private fixture'],seed);
  git(['push','-q','origin','HEAD:main'],seed);
  const request=signed();
  const env=signMuseGitRecovery(request,secret);
  const args={request,secret,token:'git-only-test-token',remoteUrl:bare};
  assert.equal(pushMuseGitRecovery(args).status,'queued');
  const filename=request.request_id+'.json';
  const result=await transactLedgerViaGit({
   token:'git-only-test-token',remoteUrl:bare,
   transform:state=>{
    state.git_recovery_processed_files={[filename]:env.signature};
    state.recovery_requests={[request.request_id]:{
      ...request,status:'OBSERVED',reason:'global_reconcile_wake_not_evidence_of_effect'}};
    return state;
   }
  });
  assert.equal(result.committed,true);
  git(['clone','-q',bare,reader],root);
  const saved=JSON.parse(readFileSync(join(reader,'dispatcher','state.json'),'utf8'));
  assert.equal(saved.recovery_requests[request.request_id].status,'OBSERVED');
  assert.equal(saved.git_recovery_processed_files[filename],env.signature);
  const read=scanMuseGitRecoveryDirectory(reader,{secret,actors,now});
  assert.equal(read.accepted.length,0,'consumed signed Git file not left in active inbox');
  assert.equal(pushMuseGitRecovery(args).status,'already_acknowledged');
  assert.ok(Number(git(['rev-list','--count','HEAD'],reader))>=3,
    'Git commit history retains signed command and its consumption');
 }finally{rmSync(root,{recursive:true,force:true});}
});
