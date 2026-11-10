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
test('merge cannot proceed without exact acceptance evidence',()=>{
 assert.equal(canMerge(rec,[],evidence).eligible,true);
 assert.equal(canMerge(rec,[],{...evidence,head_sha:'old'}).eligible,false);
 assert.equal(canMerge({...rec,draft:true},[],evidence).eligible,false);
 assert.deepEqual(canMerge({...rec,base_branch:'feat/predecessor'},[],evidence).reasons,['non_main_destination']);
 assert.equal(canMerge(rec,[{status:'merged'}],evidence).eligible,false);
});
test('merge effect checks live SHA, base, CI, Codex and squash method',async()=>{
 const calls=[];
 const pr={state:'open',draft:false,merged:false,head:{sha:'head'},base:{sha:'base',ref:'main'},mergeable:true};
 const github={request:async(path,options)=>{
   calls.push([path,options?.method]);
   if(path.endsWith('/merge'))return {merged:true,sha:'merged'};
   if(path==='/actions/runs/11/jobs?per_page=100') return {total_count:1,jobs:[{name:'AI CAFE acceptance evidence',status:'completed',conclusion:'success',html_url:'https://github.com/test',steps:[{name:'Run approved acceptance scenarios',status:'completed',conclusion:'success'}]}]};
   if(path==='/actions/runs/11')return {name:'AI CAFE Acceptance Evidence',head_sha:'head',status:'completed',conclusion:'success',event:'pull_request'};
   if(path.startsWith('/actions/runs/')) return path.includes('/jobs') ? {total_count:1,jobs:[{name:'AI CAFE PR baseline',conclusion:'success'}]} : {id:10,head_sha:'head',status:'completed',conclusion:'success',event:'pull_request'};
   if(path.startsWith('/contents/')) return {type:'file'};
   return pr;
 },one:async()=>({ci_state:'success',codex_state:'clean',codex_reviewed_sha:'head',coder_done:true,threads_resolved:true}),
 acceptanceProof:async()=>({task_id:'6',run_id:11,head_sha:'head',base_sha:'base',acceptance_digest:acceptanceDigest(evidence.acceptance),acceptance:[{...evidence.acceptance[0]}]})};
 assert.equal((await mergeApprovedPr({github,record:rec,evidence,expectedAcceptance:['scenario'],enabled:false})).status,'disabled');
 const done=await mergeApprovedPr({github,record:rec,evidence,expectedAcceptance:['scenario'],enabled:true});
 assert.equal(done.status,'merged_unproven');assert.equal(done.merge_sha,'merged');
 assert.equal(done.integration_dispatch,'requested');
 assert.deepEqual(calls.at(-2),['/pulls/100/merge','PUT']);
 assert.deepEqual(calls.at(-1),['/actions/workflows/ai-cafe-integration-proof.yml/dispatches','POST']);
 const draftPr={...pr,draft:true,node_id:'PR_100',labels:[],body:'<!-- aicafe-coder-done -->'};
 const readyCalls=[];
 const readyGitHub={...github,request:async(path,options)=>{
   readyCalls.push([path,options?.method]);
   if(path==='https://api.github.com/graphql')
     return {data:{markPullRequestReadyForReview:{pullRequest:{id:'PR_100',isDraft:false}}}};
   if(path==='/pulls/100')return draftPr;
   return github.request(path,options);
 }};
 const prepared=await mergeApprovedPr({github:readyGitHub,
   record:{...rec,draft:true,coder_done:true},evidence,expectedAcceptance:['scenario'],
   enabled:true,action:'ready'});
 assert.equal(prepared.status,'ready_for_review');
 assert.ok(readyCalls.some(([path,method])=>path==='https://api.github.com/graphql' && method==='POST'));
 assert.equal(readyCalls.some(([path])=>path==='/pulls/100/merge'),false);
 const disputed=await mergeApprovedPr({github:readyGitHub,
   record:{...rec,draft:true,coder_done:true,github_owner_question:'Approve scope expansion?'},
   evidence,expectedAcceptance:['scenario'],enabled:true,action:'ready'});
 assert.deepEqual(disputed.reasons,['owner_decision_pending']);
 const staleLabel={...readyGitHub,request:async(path,options)=>
   path==='/pulls/100'?{...draftPr,labels:[{name:'needs-owner-decision'}]}:
   readyGitHub.request(path,options)};
 assert.deepEqual((await mergeApprovedPr({github:staleLabel,
   record:{...rec,draft:true,coder_done:true},evidence,expectedAcceptance:['scenario'],
   enabled:true,action:'ready'})).reasons,['live_owner_question_pending']);
 assert.equal((await mergeApprovedPr({github:readyGitHub,record:{...rec,draft:true,coder_done:true},
   evidence,expectedAcceptance:['scenario'],enabled:false,action:'ready'})).status,'disabled');
 let readyReads=0;
 const lastMinuteReady={...readyGitHub,request:async(path,options)=>{
   if(path==='/pulls/100') {
     readyReads++;
     return readyReads===1?draftPr:{...draftPr,labels:[{name:'needs-owner-decision'}]};
   }
   return readyGitHub.request(path,options);
 }};
 assert.deepEqual((await mergeApprovedPr({github:lastMinuteReady,
   record:{...rec,draft:true,coder_done:true},evidence,expectedAcceptance:['scenario'],
   enabled:true,action:'ready'})).reasons,['live_owner_question_pending']);
 let mergeReads=0;
 const lastMinuteMerge={...github,request:async(path,options)=>{
   if(path==='/pulls/100') {
     mergeReads++;
     return mergeReads===1?pr:{...pr,body:'<!-- aicafe-owner-question Await approval -->'};
   }
   return github.request(path,options);
 }};
 assert.deepEqual((await mergeApprovedPr({github:lastMinuteMerge,
   record:rec,evidence,expectedAcceptance:['scenario'],enabled:true}))
   .reasons,['live_owner_question_pending']);
 const wrongBase={...github,request:async(path,options)=>path.startsWith('/pulls/') && !path.endsWith('/merge') ? {...pr,base:{sha:'base',ref:'feat/old'}} : github.request(path,options)};
 assert.deepEqual((await mergeApprovedPr({github:wrongBase,record:rec,evidence,expectedAcceptance:['scenario'],enabled:true})).reasons,['live_pr_changed']);
 const dispatchFail={...github,request:async(path,options)=>{if(path.includes('/dispatches'))throw Error('403');return github.request(path,options);}};
 const outcome=await mergeApprovedPr({github:dispatchFail,record:rec,evidence,expectedAcceptance:['scenario'],enabled:true});
 assert.equal(outcome.status,'merged_unproven');
 assert.equal(outcome.integration_dispatch,'failed_needs_retry');
 const invalid={...github,acceptanceProof:async()=>({task_id:'6',run_id:11,head_sha:'head',base_sha:'base',acceptance_digest:'f'.repeat(64),acceptance:evidence.acceptance})};
 assert.deepEqual((await mergeApprovedPr({github:invalid,record:rec,evidence,expectedAcceptance:['scenario'],enabled:true})).reasons,['acceptance_artifact_mismatch']);
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
