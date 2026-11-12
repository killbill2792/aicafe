import test from 'node:test';
import assert from 'node:assert/strict';
import {museOperationsContract} from './muse-operations-contract.mjs';
import {settings} from './settings.mjs';
import {transactLedgerViaGit} from './git-operations.mjs';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('versioned Muse matrix uses existing private ledger and courier transport',()=>{
 const c=museOperationsContract();
 assert.equal(c.version,1);
 assert.equal(c.schema,'aicafe.muse-operations.v1');
 assert.equal(c.project_id,settings.naming.task_prefix);
 assert.equal(c.dispatcher.repository,settings.repo);
 assert.equal(c.queue.repository,settings.ledger.repo);
 assert.equal(c.queue.state,settings.ledger.path);
 assert.equal(c.recovery.preferred_transport,'private_git_authenticated_receipt');
 assert.equal(c.recovery.raw_signing_key_required,false);
 assert.equal(c.recovery.event_type,'dispatcher_git_wake');
 assert.equal(c.recovery.receipt_kind,'muse_recovery');
 assert.equal(c.owner_relay.kind,'owner_instruction');
 assert.ok(c.writes.forbidden.includes('dispatcher/state.json'));
 assert.ok(!JSON.stringify(c).includes('DISPATCH_MUSE_RECOVERY_KEY'));
});

test('trusted Git-CAS publishes the Muse matrix atomically beside ledger',async()=>{
 const root=mkdtempSync(join(tmpdir(),'muse-operations-fixture-'));
 const git=(args,cwd)=>{
  const p=spawnSync('git',args,{cwd,encoding:'utf8'});
  if(p.status!==0)throw Error('Git fixture failed '+args[0]+': '+p.stderr);
  return p.stdout.trim();
 };
 try{
  const bare=join(root,'bare.git'),seed=join(root,'seed'),reader=join(root,'reader');
  git(['init','-q','--bare','-b','main',bare],root);
  git(['clone','-q',bare,seed],root);
  git(['config','user.email','fixture@example.com'],seed);
  git(['config','user.name','Fixture'],seed);
  mkdirSync(join(seed,'dispatcher'),{recursive:true});
  writeFileSync(join(seed,'dispatcher','state.json'),
   '{"version":1,"tasks":{},"actions":{},"owner_alerts":{}}\n');
  git(['add','.'],seed);git(['commit','-qm','seed'],seed);
  git(['push','-q','origin','HEAD:main'],seed);
  const result=await transactLedgerViaGit({
   token:'fixture-private-token',remoteUrl:bare,
   transform:state=>({...state,recovery_requests:{sample:{status:'OBSERVED'}}})
  });
  assert.equal(result.committed,true);
  git(['clone','-q',bare,reader],root);
  const saved=JSON.parse(readFileSync(
    join(reader,'dispatcher','muse-operations.json'),'utf8'));
  assert.deepEqual(saved,museOperationsContract());
  assert.equal(JSON.parse(readFileSync(join(reader,'dispatcher','state.json'),'utf8'))
    .recovery_requests.sample.status,'OBSERVED');
 }finally{rmSync(root,{recursive:true,force:true});}
});
