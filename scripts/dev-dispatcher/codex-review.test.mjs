import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCodexReview } from './codex-review.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';

const head='a'.repeat(40), base='b'.repeat(40);
const row={id:'1',command:'node --test scripts/test.test.mjs',
  test_file:'scripts/test.test.mjs',job_url:'https://github.com/o/r/actions/jobs/1',
  result:'passed'};
const evidence={head_sha:head,base_sha:base,ci_run_id:10,acceptance_run_id:20,acceptance:[row]};
const rec=()=>({task_id:'child',pr_number:423,github_state:'open',draft:false,
  head_sha:head,base_sha:base,base_branch:'main',base_current:true,
  approved:true,coder_done:true,ci_state:'success',threads_resolved:true,
  acceptance_evidence:evidence,last_commit_at:'2026-11-10T10:00:00Z'});
const task={id:'child',depends_on:['parent'],acceptance:['scenario']};
function fakeGithub({comments=[],draft=false,ci='success'}={}) {
  const posted=[];
  const pr={number:423,state:'open',draft,
    head:{sha:head},base:{sha:base,ref:'main'}};
  return {posted,request:async(path,options)=>{
    if(path==='/pulls/423')return pr;
    if(path==='/actions/runs/10')return {id:10,head_sha:head,event:'pull_request',status:'completed',conclusion:'success'};
    if(path==='/actions/runs/20')return {id:20,head_sha:head,event:'pull_request',status:'completed',conclusion:'success'};
    if(path==='/issues/423/comments' && options?.method==='POST') {
      posted.push(JSON.parse(options.body).body); return {id:10};
    }
    throw Error('Unexpected path '+path);
  },one:async()=>({...rec(),ci_state:ci,codex_reviewed_sha:null,github_owner_question:null,
    acceptance_evidence:evidence}),
  workflowJobs:async(id)=>id===10
    ? [{name:'AI CAFE PR baseline',status:'completed',conclusion:'success'}]
    : [{name:'AI CAFE acceptance evidence',status:'completed',conclusion:'success',
       steps:[{name:'Run approved acceptance scenarios',status:'completed',conclusion:'success'}]}],
  acceptanceProof:async()=>({
    task_id:'child',run_id:20,head_sha:head,base_sha:base,
    acceptance_digest:acceptanceDigest([row]),acceptance:[row]
  }),
  paginated:async()=>comments
  };
}
test('only fully proven ready head causes one dispatcher Codex request',async()=>{
  const github=fakeGithub();
  const result=await requestCodexReview({github,record:rec(),task,
    records:{parent:{status:'integrated_proven'}}});
  assert.deepEqual(result,{status:'requested',head_sha:head});
  assert.equal(github.posted.length,1);
  assert.match(github.posted[0],/@codex review/);
  assert.match(github.posted[0],new RegExp(head));
});
test('existing current-head dispatcher request is not duplicated',async()=>{
  const github=fakeGithub({comments:[{
    author_association:'COLLABORATOR',body:'@codex review\n<!-- aicafe-dispatcher-codex-review:'+head+' -->',
    created_at:'2026-11-10T11:00:00Z'
  }]});
  const result=await requestCodexReview({github,record:rec(),task,
    records:{parent:{status:'integrated_proven'}}});
  assert.equal(result.status,'already_requested');
  assert.equal(github.posted.length,0);
});

test('draft waits for automatic Codex on ready; no manual request',async()=>{
  const github=fakeGithub({draft:true});
  const current={...rec(),draft:true,coder_done:false,acceptance_evidence:null};
  const outcome=await requestCodexReview({github,record:current,task,
    records:{parent:{status:'draft_open'}}});
  assert.equal(outcome.status,'held');
  assert.equal(github.posted.length,0);
});
test('red check, older head receipt and sensitive owner hold do not trigger Codex',async()=>{
  for(const changes of [
    {ci_state:'pending'},{codex_review_requested_sha:head},
    {codex_reviewed_sha:head},{codex_state:'findings'}
  ]) {
    const github=fakeGithub();
    const result=await requestCodexReview({github,record:{...rec(),...changes},task});
    assert.equal(result.status,'held');
    assert.equal(github.posted.length,0);
  }
  const red=fakeGithub({ci:'failure'});
  assert.equal((await requestCodexReview({github:red,record:rec(),task})).status,'held_live');
});

test('authenticated running Codex summary on current head suppresses second trigger',async()=>{
  const body='<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+
    JSON.stringify({code_review:{commit_sha:head,status:'running',
      has_any_findings:null,has_unresolved_findings:null}})+' -->';
  const gh=fakeGithub({comments:[{
    user:{login:'chatgpt-codex-connector[bot]'},body,
    created_at:'2026-11-10T11:00:00Z'
  }]});
  const result=await requestCodexReview({github:gh,record:rec(),task});
  assert.equal(result.status,'already_running');
  assert.equal(gh.posted.length,0);
});

test('live current-head in-progress Codex signal holds without posting',async()=>{
  const gh=fakeGithub();
  gh.one=async()=>({...rec(),codex_in_progress_sha:head,
    codex_reviewed_sha:null,ci_state:'success',sensitive_owner_block:false});
  const result=await requestCodexReview({github:gh,record:rec(),task});
  assert.equal(result.status,'held_live');
  assert.equal(gh.posted.length,0);
});

test('five-minute push and ready settle windows suppress duplicate requests',async()=>{
 const gh=fakeGithub(),now=new Date().toISOString();
 assert.equal((await requestCodexReview({github:gh,record:{...rec(),last_commit_at:now},task})).status,'held');
 assert.equal((await requestCodexReview({github:gh,record:{...rec(),last_github_activity:now},task})).status,'held');
 assert.equal((await requestCodexReview({github:gh,record:{...rec(),ready_transition_at:now},task})).status,'held');
 gh.request=async(path)=>path==='/pulls/423'
  ? {state:'open',draft:false,created_at:now,head:{sha:head},base:{sha:base}}
  : Promise.reject(Error('Unexpected '+path));
 assert.equal((await requestCodexReview({github:gh,record:rec(),task})).status,'automatic_review_grace');
 assert.equal(gh.posted.length,0);
});
test('dispatcher-only owner-merge PR never requests Codex',async()=>{
 const gh=fakeGithub();
 assert.equal((await requestCodexReview({github:gh,record:{
   ...rec(),adhoc:true,dispatcher_only:true},task:null})).status,'held');
 assert.equal(gh.posted.length,0);
});
