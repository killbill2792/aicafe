import test from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, mergeApprovedPr, integrationStatus, safeUpdateBranch, retargetAfterIntegration, retryStartupFailure } from './effects.mjs';
import { linkPullRequests, dependencyBase, retargetDecision } from './dependencies.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';
const rec={task_id:'6',approved:true,pr_number:100,head_sha:'head',base_sha:'base',
 base_branch:'main',draft:false,ci_state:'success',codex_state:'clean',
 codex_reviewed_sha:'head',threads_resolved:true,base_current:true};
const evidence={head_sha:'head',base_sha:'base',ci_run_id:10,acceptance_run_id:11,
 acceptance:[{id:'1',command:'node --test',job_url:'https://github.com/test',test_file:'scripts/dev-dispatcher/effects.test.mjs',result:'passed'}]};
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
 const withMarker=linkPullRequests({tasks:{'6':{}}},[{pr_number:33,branch:'manual',task_marker:'6',base_branch:'main',draft:false}]);
 assert.equal(withMarker.state.tasks['6'].pr_number,33);
 const conflict=linkPullRequests({tasks:{'6':{branch:'expected'}}},[{pr_number:34,branch:'unrelated',task_marker:'6',base_branch:'main',draft:false}]);
 assert.deepEqual(conflict.unmapped,[34]);
 assert.equal(result.state.tasks['6'].pr_number,11);
 assert.deepEqual(result.unmapped,[12]);
 assert.equal(dependencyBase({depends_on:['6']},{'6':{branch:'feat/a',github_state:'open'}}).base,'feat/a');
 assert.equal(dependencyBase({depends_on:['6']},{'6':{status:'merged'}}).blocked,true);
 const branches={'6':{status:'draft_open',branch:'feat/a',github_state:'open'},
  '7':{status:'draft_open',branch:'feat/b',github_state:'open'}};
 assert.equal(dependencyBase({depends_on:['6','7'],stack_base_task:'7'},branches).base,'feat/b');
 assert.equal(dependencyBase({depends_on:['6','7']},branches).blocked,true);
 assert.equal(dependencyBase({depends_on:['6','7'],stack_base_task:'7'},
  {...branches,'7':{status:'merged',branch:'feat/b'}}).blocked,true);
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
test('legacy retarget entrypoint reuses live-verified merged parent plus branch update',async()=>{
 let patches=0, updates=0, base='feat/parent';
 const sha='f'.repeat(40);
 const gh={request:async(path,opts)=>{
   if(path==='/pulls/99')return{merged_at:'2026-11-09T22:00:00Z',
     merge_commit_sha:sha,head:{ref:'feat/parent'}};
   if(path==='/pulls/100'&&opts?.method==='PATCH'){patches++;base='main';return{};}
   if(path==='/pulls/100')return{state:'open',merged:false,
     head:{sha:'head'},base:{ref:base}};
   if(path==='/pulls/100/update-branch'){updates++;return{};}
   throw Error(path);
 }};
 const child={pr_number:100,head_sha:'head',github_state:'open'};
 const parent={pr_number:99,branch:'feat/parent',status:'merged',merge_sha:sha};
 assert.equal((await retargetAfterIntegration({github:gh,dependent:child,
   predecessor:{...parent,merge_sha:null},enabled:true})).status,'blocked');
 assert.equal(patches,0);
 const updated=await retargetAfterIntegration({github:gh,dependent:child,
   predecessor:parent,enabled:true});
 assert.equal(updated.status,'update_requested');
 assert.equal(patches,1);
 assert.equal(updates,1);
});

test('verified infrastructure CI retry is at-most-once and fails closed',async()=>{
 const eligible={...rec,github_state:'open',ci_state:'failure',ci_failure_kind:'startup_failure'};
 let state={tasks:{'6':{...eligible}}},calls=0;
 const ledger={transaction:async(fn)=>{
   const updated=fn(structuredClone(state));
   if(!updated)return {committed:false};
   state=updated;return {committed:true};
 }};
 const github={transientBaselineRun:async()=>({id:123}),rerunFailedJobs:async()=>{calls++;}};
 assert.equal((await retryStartupFailure({github,ledger,taskId:'6',record:eligible,enabled:true})).status,'retry_requested');
 assert.equal((await retryStartupFailure({github,ledger,taskId:'6',record:eligible,enabled:true})).status,'already_reserved');
 assert.equal(calls,1);
 assert.equal(state.tasks['6'].transient_ci_retry.run_id,123);
 assert.equal((await retryStartupFailure({github,ledger,taskId:'6',record:{...eligible,ci_failure_kind:null},enabled:true})).status,'not_verified_infrastructure_failure');
 assert.equal((await retryStartupFailure({github,ledger,taskId:'6',record:eligible,enabled:false})).status,'disabled');
});

test('live merge checks exact current SHA, clean Codex, threads and mergeable base',async()=>{
  const sha='a'.repeat(40),base='b'.repeat(40);
  const record={task_id:'T',pr_number:50,head_sha:sha,base_sha:base,
    draft:false,ci_state:'success',codex_state:'clean',codex_reviewed_sha:sha,
    threads_resolved:true,mergeable:true,coder_done:false,
    acceptance_proven:false,owner_question:'routine',github_owner_question:'routine'};
  let calls=[];
  const pr={number:50,state:'open',merged:false,draft:false,
    head:{sha},base:{sha:base,ref:'main'},mergeable:true,labels:[]};
  const github={request:async(path,options)=>{
    calls.push(path);
    if(path==='/pulls/50') return pr;
    if(path==='/pulls/50/merge') return {merged:true,sha:'c'.repeat(40)};
    if(path.includes('/dispatches')) return {ok:true};
    throw Error('Unexpected '+path);
  },one:async()=>({head_sha:sha,ci_state:'success',codex_state:'clean',
    codex_reviewed_sha:sha,threads_resolved:true,sensitive_owner_block:false})};
  const result=await mergeApprovedPr({github,record,enabled:true,
    predecessors:[{status:'merged',merge_sha:'d'.repeat(40)}]});
  assert.equal(result.status,'merged_unproven');
  assert.ok(calls.includes('/pulls/50/merge'));
  const stale=await mergeApprovedPr({github:{...github,one:async()=>({
    head_sha:sha,ci_state:'success',codex_state:'pending',
    codex_reviewed_sha:null,threads_resolved:true})},record,enabled:true});
  assert.deepEqual(stale.reasons,['live_checks_changed']);
  const conflict=await mergeApprovedPr({github:{...github,request:async(path,options)=>
    path==='/pulls/50'?{...pr,mergeable:false}:github.request(path,options)},
    record,enabled:true});
  assert.equal(conflict.status,'blocked');
  assert.deepEqual((await mergeApprovedPr({github,record,
    predecessors:[{status:'draft_open'}],enabled:true})).reasons,['predecessor_not_merged']);
});
test('green draft auto-ready does not require coder-done or acceptance proof',async()=>{
  const sha='a'.repeat(40),base='b'.repeat(40);
  const record={task_id:'T',pr_number:50,head_sha:sha,base_sha:base,
    draft:true,ci_state:'success',coder_done:false,acceptance_proven:false};
  const pr={state:'open',merged:false,draft:true,node_id:'PR_50',
    head:{sha},base:{sha:base,ref:'main'},mergeable:true,labels:[],body:''};
  const github={request:async(path)=>{
    if(path==='/pulls/50')return pr;
    if(path==='https://api.github.com/graphql')
      return {data:{markPullRequestReadyForReview:{pullRequest:{isDraft:false}}}};
    throw Error('Unexpected '+path);
  },one:async()=>({head_sha:sha,ci_state:'success',sensitive_owner_block:false})};
  const done=await mergeApprovedPr({github,record,enabled:true,action:'ready'});
  assert.equal(done.status,'ready_for_review');
});
