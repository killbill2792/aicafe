import test from 'node:test';
import assert from 'node:assert/strict';
import {compareLunaTrees,validateLunaReceipt,assessLunaEvidence} from './luna-evidence-validity.mjs';
const sha=c=>c.repeat(40);
const file=(path,c='a',mode='100644',type='blob')=>({path,sha:sha(c),mode,type});
const tree=(entries,root='b')=>({sha:sha(root),truncated:false,tree:entries});
test('identical content and exact reviewed document edits are comparison eligible',()=>{
 const a=tree([file('lib/ai/agent/loop.ts'),file('AGENTS.md')]);
 assert.equal(compareLunaTrees(a,a).status,'COMPARISON_ELIGIBLE');
 const b=tree([file('lib/ai/agent/loop.ts'),file('AGENTS.md','c')],'d');
 assert.deepEqual(compareLunaTrees(a,b).impact,[]);
});
test('any runtime, prompt, migration, fixture, dependency, workflow or unreviewed document change is unsafe',()=>{
 for(const p of ['lib/ai/agent/loop.ts','supabase/migrations/01.sql','package-lock.json',
  '.github/luna/scenarios/14c.json','.github/workflows/ai-cafe-luna-shared.yml',
  'scripts/acceptance/shared-luna.mjs','docs/prompt.md','app/page.tsx','unknown.bin']){
  const v=compareLunaTrees(tree([file(p)]),tree([file(p,'c')],'d'));
  assert.equal(v.status,'IMPACT_CHANGED',p);assert.deepEqual(v.impact,[p]);
 }
});
test('adds, deletes, symlinks, permission changes, gitlinks and renames cannot be exempted',()=>{
 for(const [a,b] of [
  [[],[file('AGENTS.md')]],
  [[file('AGENTS.md')],[]],
  [[file('AGENTS.md')],[file('AGENTS.md','c','120000')]],
  [[file('AGENTS.md')],[file('AGENTS.md','a','100755')]],
  [[file('AGENTS.md')],[file('docs/prompt.md')]],
  [[file('module','a','160000','commit')],[file('module','c','160000','commit')]]
 ])assert.equal(compareLunaTrees(tree(a),tree(b,'d')).status,'IMPACT_CHANGED');
});
test('incomplete, malformed or duplicate tree entries fail closed',()=>{
 const a=tree([file('AGENTS.md')]);
 for(const bad of [null,{...a,truncated:true},{...a,truncated:undefined},
  tree([file('AGENTS.md'),file('AGENTS.md')]),tree([file('../AGENTS.md')]),
  tree([file('AGENTS.md','a','100777')]),tree([{...file('AGENTS.md'),sha:'bad'}])]){
  assert.equal(compareLunaTrees(a,bad).status,'UNKNOWN');
 }
});
test('tree ancestor hash changes alone do not invalidate an otherwise eligible edit',()=>{
 const p='docs/rules/shared-luna-acceptance.md';
 const a=tree([file('docs','b','040000','tree'),file(p)]);
 const b=tree([file('docs','c','040000','tree'),file(p,'c')],'d');
 assert.equal(compareLunaTrees(a,b).status,'COMPARISON_ELIGIBLE');
});

import {createHash} from 'node:crypto';
function verified(){
 const repo='killbill2792/aicafe',runId=123,scenario='15c',candidateSha=sha('c');
 const bytes=Buffer.from('immutable fake archive test fixture');
 const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const workflow={id:45,path:'.github/workflows/ai-cafe-luna-shared.yml'};
 const run={id:runId,workflow_id:45,repository:{full_name:repo},head_repository:{full_name:repo},
  head_branch:'main',head_sha:sha('a'),actor:{login:'killbill2792'},triggering_actor:{login:'killbill2792'},
  event:'issue_comment',display_title:'luna-owner-comment-1234',run_attempt:1,status:'completed',conclusion:'success'};
 const job=(id,name,steps)=>({id,name,run_id:runId,status:'completed',conclusion:'success',
  steps:steps.map(name=>({name,conclusion:'success'}))});
 const jobs=[job(101,'Verify first owner comment run from immutable Actions history',
  ['Validate immutable owner-run authorization before any secret']),job(102,'Real Luna — '+scenario,
  ['Reverify consumed owner grant and current SHA immediately before provider access',
   'Real registered Supervisor scenario in unprivileged candidate Docker',
   'Independently verify model receipts and source/owner data on trusted host',
   'Upload only the sanitized independent verdict'])];
 const artifact={id:23,name:'luna-'+scenario+'-exact-head-host-proof',size_in_bytes:bytes.length,
  expired:false,digest,workflow_run:{id:runId,head_sha:run.head_sha,head_branch:'main'}};
 const proof={scenario,head:sha('b'),model:'gpt-6-luna',provider:'openai_responses',
  attempts:2,reservedUpperUSD:0.05,realModelAndDatabaseProof:true,
  independentDatabaseReadbacks:['source','owner','isolation'].map(kind=>({kind,passed:true}))};
 const trees={tested:tree([file('lib/ai/agent/loop.ts')]),current:tree([file('lib/ai/agent/loop.ts')])};
 const api=async path=>{
  if(path==='/actions/workflows/ai-cafe-luna-shared.yml')return workflow;
  if(path==='/actions/runs/123')return run;
  if(path.includes('/jobs?'))return {total_count:jobs.length,jobs};
  if(path.includes('/artifacts?'))return {total_count:1,artifacts:[artifact]};
  if(path==='/git/commits/'+proof.head)return {sha:proof.head,tree:{sha:trees.tested.sha}};
  if(path==='/git/commits/'+candidateSha)return {sha:candidateSha,tree:{sha:trees.current.sha}};
  if(path==='/git/trees/'+trees.tested.sha+'?recursive=1')return trees.tested;
  if(path==='/git/trees/'+trees.current.sha+'?recursive=1')return trees.current;
  throw Error('Unexpected API path');
 };
 return {scenario,runId,candidateSha,workflow,run,jobs,artifact,proof,trees,api,
  readArchive:async()=>({bytes,proof})};
}
test('trusted receipt and identical complete tree permit reuse without new spend',async()=>{
 const v=verified(),result=await assessLunaEvidence(v);
 assert.equal(result.status,'VERIFIED_REUSE');
 assert.equal(result.tested_sha,v.proof.head);
 assert.equal(result.candidate_sha,v.candidateSha);
 assert.equal(result.artifact_id,23);
});
test('wrong owner, workflow, attempt, candidate model, missing steps, mismatched artifact fail closed',async()=>{
 for(const mutate of [
  v=>v.run.actor.login='other',v=>v.run.run_attempt=2,v=>v.run.workflow_id=999,
  v=>v.run.conclusion='failure',v=>v.run.head_branch='feat/untrusted',
  v=>v.jobs[1].steps[2].conclusion='skipped',v=>v.artifact.expired=true,
  v=>v.artifact.workflow_run.id=124,v=>v.proof.scenario='14c',
  v=>v.proof.model='gpt-4.1-mini',v=>v.proof.acceptanceProof=false,
  v=>v.proof.independentDatabaseReadbacks.pop(),v=>v.proof.reservedUpperUSD=0.3,
  v=>v.artifact.digest='sha256:'+'a'.repeat(64)
 ]){
  const v=verified();mutate(v);assert.equal((await assessLunaEvidence(v)).status,'MISSING_OR_UNVERIFIED');
 }
});
test('different runtime OR unverified documentation change needs fresh proof; truncated tree is unknown',async()=>{
 for(const path of ['lib/ai/agent/loop.ts','AGENTS.md']){
  const v=verified();v.trees.current=tree([file(path,'d')],'e');
  assert.equal((await assessLunaEvidence(v)).status,'FRESH_TEST_REQUIRED');
 }
 const v=verified();v.trees.tested.truncated=true;
 assert.equal((await assessLunaEvidence(v)).status,'MISSING_OR_UNVERIFIED');
});
test('incomplete lists, archive failure and inconsistent exact commit tree cannot pass',async()=>{
 const a=verified(),api=a.api;
 a.api=async path=>path.includes('/jobs?')?{total_count:5,jobs:a.jobs}:api(path);
 assert.equal((await assessLunaEvidence(a)).status,'MISSING_OR_UNVERIFIED');
 const b=verified();b.readArchive=async()=>{throw Error('deleted artifact')};
 assert.equal((await assessLunaEvidence(b)).status,'MISSING_OR_UNVERIFIED');
 const c=verified(),read=c.api;c.api=async path=>path.startsWith('/git/commits/')?{sha:sha('f'),tree:{sha:sha('b')}}:read(path);
 assert.equal((await assessLunaEvidence(c)).status,'MISSING_OR_UNVERIFIED');
});
