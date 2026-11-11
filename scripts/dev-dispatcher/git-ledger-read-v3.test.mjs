import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readLedgerViaGit} from './git-operations.mjs';
const git=(cwd,args)=>{
 const p=spawnSync('git',args,{cwd,encoding:'utf8'});
 if(p.status!==0)throw Error('Git '+args[0]+' failed: '+p.stderr);
 return p.stdout.trim();
};
test('private ledger dashboard can read status over Git, with zero REST API calls',()=>{
 const root=mkdtempSync(join(tmpdir(),'dispatcher-v3-read-'));
 try{
  const origin=join(root,'remote.git'),work=join(root,'work');
  mkdirSync(work,{recursive:true});
  git(root,['init','--bare','-q',origin]);
  git(work,['init','-q','-b','main']);
  git(work,['config','user.email','test@example.invalid']);
  git(work,['config','user.name','V3 test']);
  mkdirSync(join(work,'dispatcher'),{recursive:true});
  const expected={version:1,tasks:{A:{status:'review_fixing'}},actions:{},
   updated_at:'2026-11-11T10:00:00Z'};
  writeFileSync(join(work,'dispatcher/state.json'),JSON.stringify(expected));
  git(work,['add','.']);git(work,['commit','-q','-m','state']);
  git(work,['remote','add','origin',origin]);git(work,['push','-q','-u','origin','main']);
  const loaded=readLedgerViaGit({token:'mock-credential',remoteUrl:origin});
  assert.deepEqual(loaded,expected);
  assert.throws(()=>readLedgerViaGit({repo:'other/unsafe',token:'mock-credential',
    remoteUrl:origin}),/not authorized/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
