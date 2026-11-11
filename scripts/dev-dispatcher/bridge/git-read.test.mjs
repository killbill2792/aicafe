import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fetchLedger,fetchLedgerViaGit} from './bridge.mjs';
const run=(cwd,args)=>{
 const p=spawnSync('git',args,{cwd,encoding:'utf8'});
 if(p.status!==0)throw Error('Git fixture failure '+p.stderr);
 return p.stdout.trim();
};
test('Muse can consume Git-backed emergency owner notice without GitHub REST',async()=>{
 const root=mkdtempSync(join(tmpdir(),'muse-queue-git-'));
 try{
  const bare=join(root,'remote.git'),work=join(root,'work');
  run(root,['init','--bare','-q',bare]);
  run(root,['clone','-q',bare,work]);
  run(work,['config','user.email','fixture@example.invalid']);
  run(work,['config','user.name','Fixture']);
  const file='dispatcher/state.json';
  mkdirSync(dirname(join(work,file)),{recursive:true});
  writeFileSync(join(work,file),JSON.stringify({version:1,tasks:{},actions:{},
    owner_alerts:{one:{kind:'dispatcher_emergency',recipient:'owner',delivery_owner:'muse',
      status:'planned',question:'GitHub rate limit reached'}}}));
  run(work,['add','.']);run(work,['commit','-qm','seed']);
  run(work,['push','-q','origin','HEAD:refs/heads/main']);
  const state=await fetchLedgerViaGit({repo:'owner/private-ledger',
    ledgerPath:file,remoteUrl:bare});
  assert.equal(state.owner_alerts.one.status,'planned');
  const throughBridge=await fetchLedger({repo:'owner/private-ledger',ledgerPath:file,
    gitRead:true,gitFetch:()=>fetchLedgerViaGit({repo:'owner/private-ledger',
      ledgerPath:file,remoteUrl:bare}),fetchImpl:()=>{throw Error('REST is unreachable')}});
  assert.equal(throughBridge.owner_alerts.one.recipient,'owner');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('REST primary quota exhaustion switches Muse to existing Git transport',async()=>{
 let calls=0;
 const state={version:1,tasks:{},actions:{},owner_alerts:{issue:{status:'planned'}}};
 const result=await fetchLedger({repo:'owner/private-ledger',token:'fake',ledgerPath:'dispatcher/state.json',
   gitFetch:()=>{calls++;return state;},fetchImpl:async url=>{
     if(url==='https://api.github.com/repos/owner/private-ledger')
       return {ok:true,json:async()=>({private:true})};
     return {ok:false,status:429,headers:{get:key=>key==='x-ratelimit-remaining'?'0':null}};
   }});
 assert.equal(result,state);
 assert.equal(calls,1);
});
