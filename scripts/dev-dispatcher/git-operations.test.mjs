import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {settings} from './settings.mjs';
import {gitAuthEnvironment,publishEmergencyViaGit,updateBranchViaGit} from './git-operations.mjs';

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
