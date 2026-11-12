import test from 'node:test';
import assert from 'node:assert/strict';
import {recentMergeTitles,eligibleMissingTaskIds,discoverMergedPrEvidence,
 applyMergedPrEvidence,recoveredMergeIntegrationAllowed} from './merged-pr-recovery.mjs';
const merge='3'.repeat(40),head='a'.repeat(40),main='b'.repeat(40);
const task10={task_id:'10',status:'assigned',approved:true,
 approval_hash:'f'.repeat(64),scope_approval_hash:'c'.repeat(64),
 branch:'feat/aicafe-task-10',conversation_ref:'https://chatgpt.com/c/original'};
const task9={task_id:'9',status:'assigned',approved:true,
 approval_hash:'e'.repeat(64),branch:'feat/aicafe-task-9'};
const state=()=>({version:1,tasks:{'10':{...task10},'9':{...task9}},
 actions:{'assign:10':{task_id:'10',status:'planned'}},
 owner_alerts:{},scope_authorizations:{
  '10':{edits:['lib/gateway.ts'],plan_hash:'p'.repeat(64)},
  '9':{edits:['lib/thread-memory.ts']}}});
const commitTitle=merge+'\tfeat(supervisor): Task 10 unified gateway (#443)';
const pr=({body='<!-- aicafe-task-id 10 -->',owner='killbill2792',
 branch='feat/aicafe-task-10-effect-gateway',files=1}={})=>({
 number:443,merged_at:'2026-11-12T04:35:07Z',merge_commit_sha:merge,
 body,user:{login:owner},changed_files:files,
 head:{sha:head,ref:branch,repo:{full_name:'killbill2792/aicafe'}},
 base:{ref:'main',repo:{full_name:'killbill2792/aicafe'}}
});
function mocks(detail=pr(),files=['lib/gateway.ts']){
 const calls=[];
 const github={request:async path=>{
  calls.push(path);
  if(path==='/pulls/443')return detail;
  if(path==='/pulls/443/files?per_page=100&page=1')
   return files.map(file=>typeof file==='string'?{filename:file,status:'modified'}:file);
  throw Error('Unexpected GitHub request '+path);
 }};
 return {github,calls};
}
test('Git first-parent merge log discovers Task 10 PR #443 without scanning every PR',()=>{
 const found=recentMergeTitles([
   merge+'\tMerge unrelated pull request #400',
   commitTitle,
   merge+'\tfeat(supervisor): Task 9 other patch (#442)'
 ].join('\n'),{taskIds:['10'],maxResults:5});
 assert.equal(found.length,1);
 assert.equal(found[0].pr_number,443);
 assert.equal(found[0].task_id,'10');
});
test('only previously approved missing task identities enter historic recovery',()=>{
 const s=state();
 assert.deepEqual(eligibleMissingTaskIds(s),['9','10']);
 s.tasks['9'].pr_number=442;
 assert.deepEqual(eligibleMissingTaskIds(s),['10']);
});
test('merged #443 is linked from trusted merge title + owner + task marker, not branch alias',async()=>{
 const s=state();s.tasks['9'].pr_number=442;
 const {github,calls}=mocks();
 const evidence=await discoverMergedPrEvidence({github,state:s,mainSha:main,
  now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 assert.deepEqual(calls,['/pulls/443','/pulls/443/files?per_page=100&page=1']);
 assert.equal(evidence.candidates.length,1);
 const next=applyMergedPrEvidence(s,evidence,'2026-11-12T06:30:00Z');
 assert.equal(next.tasks['10'].pr_number,443);
 assert.equal(next.tasks['10'].github_state,'merged');
 assert.equal(next.tasks['10'].status,'merged');
 assert.equal(next.tasks['10'].merge_sha,merge);
 assert.equal(next.tasks['10'].branch,'feat/aicafe-task-10-effect-gateway');
 assert.equal(next.tasks['10'].approval_hash,s.tasks['10'].approval_hash);
 assert.equal(next.tasks['10'].scope_approval_hash,s.tasks['10'].scope_approval_hash);
 assert.deepEqual(next.tasks['9'],s.tasks['9']);
 assert.equal(next.actions['assign:10'].status,'cancelled_merged_pr_recovered');
 assert.equal(s.actions['assign:10'].status,'planned',
   'the original read-only task state remains untouched');
 assert.equal(next.tasks['10'].integration_proof,undefined);
});
test('additional merged PR file is shown as owner scope audit, never silently approved',async()=>{
 const s=state(),{github}=mocks(pr({files:2}),
  ['lib/gateway.ts','lib/extra-owner-approved-but-not-signed.ts']);
 const evidence=await discoverMergedPrEvidence({github,state:s,mainSha:main,
  now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 const next=applyMergedPrEvidence(s,evidence);
 assert.deepEqual(next.tasks['10'].recovered_pr_unsigned_files,
  ['lib/extra-owner-approved-but-not-signed.ts']);
 assert.ok(Object.values(next.owner_alerts).some(a=>a.kind==='merged_pr_scope_audit'));
 assert.equal(next.tasks['10'].status,'merged');
 assert.equal(next.tasks['10'].approved,true);
 assert.equal(next.tasks['10'].integration_proof,undefined);
});
test('unverified marker, author or head repository fails closed',async()=>{
 for(const detail of [
  pr({body:'<!-- aicafe-task-id 9 -->'}),
  pr({owner:'untrusted-user'}),
  {...pr(),head:{...pr().head,repo:{full_name:'other/repo'}}},
  {...pr(),merge_commit_sha:'f'.repeat(40)}
 ]){
  const {github}=mocks(detail);
  const evidence=await discoverMergedPrEvidence({github,state:state(),
   mainSha:main,now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
  assert.equal(evidence.candidates.length,0);
  assert.equal(evidence.blocked.length,1);
  assert.equal(applyMergedPrEvidence(state(),evidence).tasks['10'].pr_number,undefined);
 }
});
test('missing scope and incomplete file pagination cannot link historic merged PR',async()=>{
 const s=state();delete s.scope_authorizations['10'];
 const {github,calls}=mocks();
 const empty=await discoverMergedPrEvidence({github,state:s,mainSha:main,
  now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 assert.equal(empty.candidates.length,0);
 assert.deepEqual(calls,[]);
 const invalid=mocks(pr({files:2}),['lib/gateway.ts']);
 const out=await discoverMergedPrEvidence({github:invalid.github,state:state(),
  mainSha:main,now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 assert.equal(out.candidates.length,0);
 assert.equal(out.blocked[0].reason,'merged_pr_changed_files_incomplete');
});
test('historic Git candidate scan is limited to one per hour after previous audit',async()=>{
 const s=state();s.merged_pr_discovery_at='2026-11-12T06:00:00Z';
 const {github,calls}=mocks();
 const result=await discoverMergedPrEvidence({github,state:s,
  mainSha:main,now:'2026-11-12T06:10:00Z',
  gitHistory:()=>{throw Error('No historic read allowed yet')}});
 assert.equal(result.checked,false);assert.deepEqual(calls,[]);
});


test('historical merge never cancels uncertain/submitted receipts or other task actions',()=>{
 const s=state();
 s.actions['assign:10'].status='uncertain';
 s.actions['assign:9']={task_id:'9',type:'assign',status:'planned'};
 const next=applyMergedPrEvidence(s,{candidates:[{
   task_id:'10',pr_number:443,merge_sha:merge,head_sha:head,
   branch:'feat/aicafe-task-10-effect-gateway',base_branch:'main',
   merged_at:'2026-11-12T04:35:07Z',unsigned_files:[]}],checked:true});
 assert.equal(next.actions['assign:10'].status,'uncertain');
 assert.deepEqual(next.actions['assign:9'],s.actions['assign:9']);
 assert.deepEqual(next.tasks['9'],s.tasks['9']);
});


test('historically recovered unsigned merged PR cannot be labelled integrated-proven',()=>{
 assert.equal(recoveredMergeIntegrationAllowed({
   pr_link_recovery:'verified_git_merge_and_owner_pr_marker',
   recovered_pr_unsigned_files:['lib/unapproved.ts']}),false);
 assert.equal(recoveredMergeIntegrationAllowed({
   pr_link_recovery:'verified_git_merge_and_owner_pr_marker',
   recovered_pr_unsigned_files:[]}),true);
 assert.equal(recoveredMergeIntegrationAllowed({status:'merged'}),true);
});

test('Codex P1: historical PR rename audits unsigned source and approved destination',async()=>{
 const s=state();
 const {github}=mocks(pr({files:1}),[{status:'renamed',
   filename:'lib/gateway.ts',previous_filename:'lib/unapproved-private.ts'}]);
 const evidence=await discoverMergedPrEvidence({github,state:s,mainSha:main,
   now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 assert.equal(evidence.candidates.length,1);
 assert.deepEqual(evidence.candidates[0].unsigned_files,['lib/unapproved-private.ts']);
 const next=applyMergedPrEvidence(s,evidence);
 assert.equal(recoveredMergeIntegrationAllowed(next.tasks['10']),false);
 assert.ok(Object.values(next.owner_alerts).some(a=>a.kind==='merged_pr_scope_audit'));
 assert.equal(next.tasks['9'].pr_number,undefined);
});
test('historical PR rename missing source path fails closed, even with approved destination',async()=>{
 const s=state();
 const {github}=mocks(pr({files:1}),[{status:'renamed',filename:'lib/gateway.ts'}]);
 const evidence=await discoverMergedPrEvidence({github,state:s,mainSha:main,
   now:'2026-11-12T06:30:00Z',gitHistory:()=>commitTitle});
 assert.equal(evidence.candidates.length,0);
 assert.equal(evidence.blocked[0].reason,'merged_pr_changed_files_incomplete');
 assert.equal(applyMergedPrEvidence(s,evidence).tasks['10'].pr_number,undefined);
});
