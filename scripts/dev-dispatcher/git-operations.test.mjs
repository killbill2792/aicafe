import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {settings} from './settings.mjs';
import {gitAuthEnvironment,publishEmergencyViaGit,updateBranchViaGit,transactLedgerViaGit,publishOwnerQueueViaGit,readApiPauseViaGit} from './git-operations.mjs';

const sha='a'.repeat(40);
const run=(args,cwd)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});
  if(r.status!==0)throw Error('Git test command failed '+args[0]+': '+r.stderr);return r.stdout.trim();};
const fixture=()=>{
 const root=mkdtempSync(join(tmpdir(),'dispatcher-git-test-'));
 const bare=join(root,'bare.git'),work=join(root,'work');
 run(['init','--bare','-q',bare],root);
 run(['clone','-q',bare,work],root);
 run(['config','user.email','test@example.invalid'],work);
 run(['config','user.name','Test'],work);
 return {root,bare,work,cleanup:()=>rmSync(root,{recursive:true,force:true})};
};
test('Git authentication is environment-only, never a credential URL',()=>{
 const env=gitAuthEnvironment('secret-test',{GIT_CONFIG_COUNT:'0'});
 assert.equal(env.GIT_CONFIG_COUNT,'1');
 assert.match(env.GIT_CONFIG_VALUE_0,/^AUTHORIZATION: basic /);
 assert.equal(env.GIT_CONFIG_KEY_0,'http.https://github.com/.extraheader');
 assert.doesNotMatch(env.GIT_CONFIG_VALUE_0,/secret-test/);
});
test('a Git emergency preserves ledger actions and appears in existing Muse owner queue',()=>{
 const f=fixture();
 try {
  const path=settings.ledger.path;
  mkdirSync(dirname(join(f.work,path)),{recursive:true});
  writeFileSync(join(f.work,path),JSON.stringify({version:1,tasks:{worker:{approved:true}},
    actions:{original:{status:'submitted'}},owner_alerts:{}}));
  run(['add','.'],f.work);run(['commit','-qm','seed'],f.work);
  run(['push','-q','origin','HEAD:refs/heads/main'],f.work);
  const args={repo:settings.ledger.repo,token:'local-test-only',identity:'run:unit:test',
   message:'GitHub rate limit exhausted',remoteUrl:f.bare};
  const a=publishEmergencyViaGit(args);
  assert.equal(a.status,'queued');
  assert.equal(publishEmergencyViaGit(args).status,'already_queued');
  run(['pull','-q','origin','main'],f.work);
  const state=JSON.parse(readFileSync(join(f.work,path),'utf8'));
  assert.equal(state.actions.original.status,'submitted');
  const notice=Object.values(state.owner_alerts).find(n=>n.notice_hash===a.notice_hash);
  assert.equal(notice.status,'planned');
  assert.equal(notice.delivery_owner,'muse');
  assert.equal(notice.recipient,'owner');
  assert.match(readFileSync(join(f.work,settings.ledger.owner_view_path),'utf8'),/GitHub rate limit exhausted/);
 } finally {f.cleanup();}
});
test('Git emergency fails loudly without a queue credential',()=>{
 assert.throws(()=>publishEmergencyViaGit({identity:'run:unit',message:'error'}),/Invalid emergency/);
});
test('branch updater does not silently fall back to Actions token',()=>{
 assert.deepEqual(updateBranchViaGit({repo:settings.repo,branch:'feature/pr',expectedHeadSha:sha}),
   {status:'missing_git_credential'});
});
test('branch updater rejects stale heads and updates only verified child branch',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.work,'file.txt'),'base\n');
  run(['add','.'],f.work);run(['commit','-qm','base'],f.work);
  run(['branch','-M','main'],f.work);run(['push','-q','origin','main'],f.work);
  run(['checkout','-qb','feat/child'],f.work);
  writeFileSync(join(f.work,'child.txt'),'child\n');
  run(['add','.'],f.work);run(['commit','-qm','child'],f.work);
  const childHead=run(['rev-parse','HEAD'],f.work);
  run(['push','-q','origin','feat/child'],f.work);
  run(['checkout','-q','main'],f.work);
  writeFileSync(join(f.work,'file.txt'),'updated\n');
  run(['commit','-qam','parent changed'],f.work);
  run(['push','-q','origin','main'],f.work);
  const args={repo:settings.repo,branch:'feat/child',expectedHeadSha:childHead,
    token:'local-test-only',remoteUrl:f.bare};
  assert.equal(updateBranchViaGit({...args,expectedHeadSha:sha}).status,'stale_head');
  const updated=updateBranchViaGit(args);
  assert.equal(updated.status,'updating');
  assert.match(updated.new_head_sha,/^[a-f0-9]{40}$/);
  assert.notEqual(updated.new_head_sha,childHead);
  assert.equal(updateBranchViaGit(args).status,'stale_head');
 }finally{f.cleanup();}
});

test('a genuine Git merge conflict is classified separately from transport errors',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.work,'shared.txt'),'base\n');
  run(['add','.'],f.work);run(['commit','-qm','base'],f.work);
  run(['branch','-M','main'],f.work);run(['push','-q','origin','main'],f.work);
  run(['checkout','-qb','feat/conflict'],f.work);
  writeFileSync(join(f.work,'shared.txt'),'child change\n');
  run(['commit','-qam','child'],f.work);
  const original=run(['rev-parse','HEAD'],f.work);
  run(['push','-q','origin','feat/conflict'],f.work);
  run(['checkout','-q','main'],f.work);
  writeFileSync(join(f.work,'shared.txt'),'main change\n');
  run(['commit','-qam','main'],f.work);
  run(['push','-q','origin','main'],f.work);
  const result=updateBranchViaGit({repo:settings.repo,branch:'feat/conflict',
    expectedHeadSha:original,token:'local-test-only',remoteUrl:f.bare});
  assert.equal(result.status,'conflict_needs_coder');
  assert.equal(run(['rev-parse','refs/heads/feat/conflict'],f.work),original);
 } finally {f.cleanup();}
});

test('Git-backed ledger transaction preserves concurrent writes with fresh retry',async()=>{
 const f=fixture();
 try{
  run(['branch','-M','main'],f.work);
  mkdirSync(dirname(join(f.work,settings.ledger.path)),{recursive:true});
  writeFileSync(join(f.work,settings.ledger.path),JSON.stringify({
   version:1,tasks:{T:{approved:true}},actions:{},owner_alerts:{}
  }));
  run(['add','.'],f.work);run(['commit','-qm','seed'],f.work);
  run(['push','-q','origin','main'],f.work);
  let injectOnce=true,attempts=0;
  const result=await transactLedgerViaGit({repo:settings.ledger.repo,token:'local-only',
    remoteUrl:f.bare,transform:next=>{
      attempts++;
      if(injectOnce){
        injectOnce=false;
        writeFileSync(join(f.work,'concurrent.txt'),'outside update\n');
        run(['add','.'],f.work);run(['commit','-qm','concurrent owner update'],f.work);
        run(['push','-q','origin','main'],f.work);
      }
      next.actions['verified']={status:'planned'};return next;
    }});
  assert.equal(result.committed,true);
  assert.equal(attempts,2);
  run(['pull','-q','origin','main'],f.work);
  assert.equal(readFileSync(join(f.work,'concurrent.txt'),'utf8'),'outside update\n');
  const state=JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8'));
  assert.equal(state.actions.verified.status,'planned');
  assert.match(readFileSync(join(f.work,settings.ledger.owner_view_path),'utf8'),/private Muse delivery queue/);
  assert.equal(publishOwnerQueueViaGit({repo:settings.ledger.repo,token:'local-only',
    remoteUrl:f.bare}).status,'unchanged');
 }finally{f.cleanup();}
});

test('API outage has one durable Muse incident and suppresses repeated run alerts',()=>{
 const f=fixture();
 try {
  run(['branch','-M','main'],f.work);
  mkdirSync(dirname(join(f.work,settings.ledger.path)),{recursive:true});
  writeFileSync(join(f.work,settings.ledger.path),JSON.stringify({
    version:1,tasks:{},actions:{},owner_alerts:{}
  }));
  run(['add','.'],f.work);run(['commit','-qm','seed'],f.work);
  run(['push','-q','origin','main'],f.work);
  const resetAt=new Date(Date.now()+30*60000).toISOString();
  const identity='github_api_rate_limit:'+resetAt;
  const args={repo:settings.ledger.repo,token:'local-test-only',remoteUrl:f.bare,
    identity,resetAt,message:'GitHub API quota reached',needs:'Notify owner'};
  assert.equal(publishEmergencyViaGit(args).status,'queued');
  assert.equal(publishEmergencyViaGit({...args,identity:'run:982:failure'}).status,'already_queued');
  const pause=readApiPauseViaGit({repo:settings.ledger.repo,token:'local-test-only',remoteUrl:f.bare});
  assert.equal(pause.until,resetAt);
  assert.equal(pause.identity,identity);
  run(['pull','-q','origin','main'],f.work);
  const ledger=JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8'));
  assert.equal(Object.values(ledger.owner_alerts).length,1);
  assert.equal(Object.values(ledger.owner_alerts)[0].delivery_owner,'muse');
 } finally {f.cleanup();}
});


test('Git-backed CAS compacts a >1 MiB ledger and preserves private archive atomically',async()=>{
 const f=fixture();
 try {
   run(['branch','-M','main'],f.work);
   mkdirSync(dirname(join(f.work,settings.ledger.path)),{recursive:true});
   const old='2026-11-11T20:00:00Z';
   const history=Object.fromEntries(Array.from({length:700},(_,i)=>['wake-'+i,{
     key:'wake-'+i,status:'requested',requested_at:old,
     description:'old deterministic history '+'.'.repeat(200)}]));
   const alerts=Object.fromEntries(Array.from({length:125},(_,i)=>['notice:old'+i,{
     kind:'dispatcher_emergency',identity:'run:'+i,notice_hash:'old'+i,
     status:'resolved',question:'historical '.repeat(90),
     owner_message:'historical '.repeat(90),created_at:old}]));
   alerts['notice:live']={kind:'owner_decision',status:'planned',notice_hash:'live',
     question:'This pending owner question must survive unchanged',created_at:old};
   const state={version:1,tasks:{T:{approved:true}},
     actions:{original:{status:'submitted'},payload:{status:'planned',
       provenance:'x'.repeat(500_000)}},
     owner_alerts:alerts,delayed_wake_history:history};
   const initial=JSON.stringify(state,null,2)+'\n';
   assert.ok(Buffer.byteLength(initial)>1_000_000);
   writeFileSync(join(f.work,settings.ledger.path),initial);
   run(['add','.'],f.work);run(['commit','-qm','oversized seed'],f.work);
   run(['push','-q','origin','main'],f.work);
   const result=await transactLedgerViaGit({repo:settings.ledger.repo,
     token:'test-only',remoteUrl:f.bare,transform:next=>{
       next.tasks.T.last_checked='2026-11-12T00:50:00Z';return next;
     }});
   assert.equal(result.committed,true);
   run(['pull','-q','origin','main'],f.work);
   const updated=JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8'));
   assert.ok(Buffer.byteLength(readFileSync(join(f.work,settings.ledger.path)))<1_000_000);
   assert.equal(updated.actions.payload.provenance.length,500_000);
   assert.equal(updated.owner_alerts['notice:live'].status,'planned');
   assert.ok(updated.ledger_archives.length>0);
   const archive=JSON.parse(readFileSync(join(f.work,updated.ledger_archives.at(-1).path),'utf8'));
   assert.equal(Object.keys(archive.delayed_wake_history).length,700);
   assert.equal(Object.keys(archive.owner_alerts).length,125);
   assert.equal(archive.owner_alerts['notice:old1'].question,alerts['notice:old1'].question);
 } finally {f.cleanup();}
});
test('consecutive Git emergency run IDs reuse one recent owner notice',()=>{
 const f=fixture();
 try {
   run(['branch','-M','main'],f.work);
   mkdirSync(dirname(join(f.work,settings.ledger.path)),{recursive:true});
   writeFileSync(join(f.work,settings.ledger.path),JSON.stringify({
     version:1,tasks:{},actions:{},owner_alerts:{}}));
   run(['add','.'],f.work);run(['commit','-qm','seed'],f.work);
   run(['push','-q','origin','main'],f.work);
   const args={repo:settings.ledger.repo,token:'local-only',remoteUrl:f.bare};
   assert.equal(publishEmergencyViaGit({...args,identity:'run:100:failure',message:'first crash'}).status,'queued');
   assert.equal(publishEmergencyViaGit({...args,identity:'run:101:failure',message:'same crash'}).status,'already_queued');
   run(['pull','-q','origin','main'],f.work);
   const state=JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8'));
   assert.equal(Object.keys(state.owner_alerts).length,1);
 } finally {f.cleanup();}
});
