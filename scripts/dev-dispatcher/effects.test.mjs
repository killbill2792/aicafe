import test from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, mergeApprovedPr, integrationStatus, safeUpdateBranch, retargetAfterIntegration } from './effects.mjs';
import { linkPullRequests, dependencyBase, retargetDecision } from './dependencies.mjs';
const rec={task_id:'6',approved:true,pr_number:100,head_sha:'head',base_sha:'base',
 base_branch:'main',draft:false,ci_state:'success',codex_state:'clean',
 codex_reviewed_sha:'head',threads_resolved:true,base_current:true};
const evidence={head_sha:'head',base_sha:'base',ci_run_id:10,
 acceptance:[{id:'a',command:'node --test',job_url:'https://github.com/test',result:'passed'}]};
test('merge cannot proceed without exact acceptance evidence',()=>{
 assert.equal(canMerge(rec,[],evidence).eligible,true);
 assert.equal(canMerge(rec,[],{...evidence,head_sha:'old'}).eligible,false);
 assert.equal(canMerge({...rec,draft:true},[],evidence).eligible,false);
 assert.equal(canMerge(rec,[{status:'merged'}],evidence).eligible,false);
});
test('merge effect checks live SHA, base, CI, Codex and squash method',async()=>{
 const calls=[];
 const pr={state:'open',draft:false,merged:false,head:{sha:'head'},base:{sha:'base',ref:'main'},mergeable:true};
 const github={request:async(path,options)=>{
   calls.push([path,options?.method]);
   if(path.endsWith('/merge'))return {merged:true,sha:'merged'};
   return pr;
 },one:async()=>({ci_state:'success',codex_state:'clean',codex_reviewed_sha:'head',threads_resolved:true})};
 assert.equal((await mergeApprovedPr({github,record:rec,evidence,enabled:false})).status,'disabled');
 const done=await mergeApprovedPr({github,record:rec,evidence,enabled:true});
 assert.equal(done.status,'merged_unproven');assert.equal(done.merge_sha,'merged');
 assert.deepEqual(calls.at(-1),['/pulls/100/merge','PUT']);
});
test('integration requires actual main SHA and passing scenario run',()=>{
 const args={merged_sha:'merged',main_sha:'main',
 proof:{merged_sha:'merged',main_sha:'main',conclusion:'success',workflow_run_id:42,
 required_scenarios:[{result:'passed'}]}};
 assert.equal(integrationStatus(args),'integrated_proven');
 assert.equal(integrationStatus({...args,main_sha:'new'}),'merged_unproven');
 assert.equal(integrationStatus({...args,proof:{...args.proof,required_scenarios:[]}}),'merged_unproven');
});
test('PR matching never guesses and dependent bases require evidence',()=>{
 const state={tasks:{'6':{branch:'feat/a'},'7':{branch:'feat/b'}}};
 const prs=[{pr_number:11,branch:'feat/a',base_branch:'main',draft:false},
 {pr_number:12,branch:'unknown',base_branch:'main',draft:false}];
 const result=linkPullRequests(state,prs);
 assert.equal(result.state.tasks['6'].pr_number,11);
 assert.deepEqual(result.unmapped,[12]);
 assert.equal(dependencyBase({depends_on:['6']},{'6':{branch:'feat/a',github_state:'open'}}).base,'feat/a');
 assert.equal(dependencyBase({depends_on:['6']},{'6':{status:'merged'}}).blocked,true);
 assert.equal(retargetDecision({dependent:{pr_number:13},predecessor:{branch:'feat/a'},predecessorMerged:true,currentBase:'feat/a'}).allowed,true);
});

test('safe update branch requires live SHA and blocks conflicts',async()=>{
 let writes=0;
 const gh={request:async(path,opts)=>{
  if(opts?.method==='PUT'){writes++;return {message:'updating'};}
  return {state:'open',merged:false,mergeable:true,head:{sha:'head'},base:{ref:'main'}};
 }};
 assert.equal((await safeUpdateBranch({github:gh,record:{...rec,github_state:'open'},enabled:true})).status,'updating');
 assert.equal(writes,1);
 assert.equal((await safeUpdateBranch({github:gh,record:{...rec,head_sha:'stale',github_state:'open'},enabled:true})).status,'blocked');
 assert.equal(writes,1);
});
test('retarget requires integrated predecessor and matching live base',async()=>{
 let writes=0;
 const gh={request:async(path,opts)=>{
  if(opts?.method==='PATCH'){writes++;return {base:{ref:'main'}};}
  return {state:'open',head:{sha:'head'},base:{ref:'feat/parent'}};
 }};
 const dependent={pr_number:100,head_sha:'head'};
 const predecessor={branch:'feat/parent',status:'merged'};
 assert.equal((await retargetAfterIntegration({github:gh,dependent,predecessor,enabled:true})).status,'blocked');
 assert.equal((await retargetAfterIntegration({github:gh,dependent,predecessor:{...predecessor,status:'integrated_proven'},enabled:true})).status,'retargeted');
 assert.equal(writes,1);
});
