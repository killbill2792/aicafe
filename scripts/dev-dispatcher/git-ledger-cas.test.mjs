import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {settings} from './settings.mjs';
import {transactLedgerViaGit,publishOwnerQueueViaGit} from './git-operations.mjs';

const git=(cwd,args)=>{
 const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000});
 if(r.status!==0)throw Error('Fixture git failed: '+args[0]+' '+r.stderr);
 return r.stdout.trim();
};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'git-cas-proof-'));
 const bare=join(root,'remote.git'),work=join(root,'work');
 git(root,['init','--bare','-q',bare]);
 git(root,['clone','-q',bare,work]);
 git(work,['config','user.name','Fixture']);
 git(work,['config','user.email','fixture@example.invalid']);
 const filename=join(work,settings.ledger.path);
 mkdirSync(dirname(filename),{recursive:true});
 writeFileSync(filename,JSON.stringify({version:1,tasks:{},actions:{},owner_alerts:{}}));
 git(work,['add','.']);git(work,['commit','-qm','seed']);
 git(work,['push','-q','origin','HEAD:refs/heads/main']);
 return {root,bare,work,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('normal Git ledger CAS writes state and existing Muse owner queue, no REST',async()=>{
 const f=fixture();
 try{
  const args={repo:settings.ledger.repo,token:'fixture-only',remoteUrl:f.bare};
  const result=await transactLedgerViaGit({...args,transform:state=>{
   state.owner_alerts.incident={kind:'dispatcher_emergency',status:'planned',
    recipient:'owner',delivery_owner:'muse',question:'API failure'};
   return state;
  }});
  assert.equal(result.committed,true);
  git(f.work,['pull','-q','origin','main']);
  const state=JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8'));
  assert.equal(state.owner_alerts.incident.status,'planned');
  assert.match(readFileSync(join(f.work,settings.ledger.owner_view_path),'utf8'),/API failure/);
  assert.equal(publishOwnerQueueViaGit(args).status,'unchanged');
  assert.equal((await transactLedgerViaGit({...args,transform:()=>null})).committed,false);
 }finally{f.cleanup();}
});
test('non-force CAS retries an actual concurrent push and preserves both changes',async()=>{
 const f=fixture();
 try{
  let raced=false;
  const invoke=(cmd,args,options)=>{
   if(!raced&&cmd==='git'&&args[0]==='push'&&args.includes('HEAD:refs/heads/main')){
    raced=true;
    writeFileSync(join(f.work,'competing.txt'),'other writer was here\n');
    git(f.work,['add','competing.txt']);
    git(f.work,['commit','-qm','concurrent authorized writer']);
    git(f.work,['push','-q','origin','HEAD:refs/heads/main']);
   }
   return spawnSync(cmd,args,options);
  };
  const out=await transactLedgerViaGit({
   repo:settings.ledger.repo,token:'fixture-only',
   remoteUrl:f.bare,run:invoke,transform:state=>{
    state.tasks.task={approved:true};
    return state;
   }
  });
  assert.equal(raced,true);
  assert.equal(out.committed,true);
  git(f.work,['pull','-q','origin','main']);
  assert.equal(readFileSync(join(f.work,'competing.txt'),'utf8'),'other writer was here\n');
  assert.equal(JSON.parse(readFileSync(join(f.work,settings.ledger.path),'utf8')).tasks.task.approved,true);
 }finally{f.cleanup();}
});
