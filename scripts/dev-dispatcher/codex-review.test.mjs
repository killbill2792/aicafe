import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCodexReview, codexWatchDecision, codexWatchMinutes, inspectCodexWatch, rerequestCodexReview } from './codex-review.mjs';
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

test('green current head triggers Codex even for draft with no coder-done or acceptance',async()=>{
  const github=fakeGithub({draft:true});
  const current={...rec(),draft:true,coder_done:false,acceptance_evidence:null};
  const outcome=await requestCodexReview({github,record:current,task,
    records:{parent:{status:'draft_open'}}});
  assert.equal(outcome.status,'requested');
  assert.equal(github.posted.length,1);
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

const requestedAt='2026-11-10T10:00:00Z';
const watchdogRecord=()=>({...rec(),codex_review_requested_sha:head,codex_state:'pending'});
const firstRequest={id:10,created_at:requestedAt,author_association:'OWNER',
  user:{login:'killbill2792'},body:'@codex review\n<!-- aicafe-dispatcher-codex-review:'+head+' -->'};
const secondRequest={id:11,created_at:'2026-11-10T10:21:00Z',author_association:'OWNER',
  user:{login:'killbill2792'},body:'@codex review\n<!-- aicafe-dispatcher-codex-rerequest:'+head+' -->'};
const decision=(at,comments=[firstRequest],extras={})=>codexWatchDecision({
  record:watchdogRecord(),comments,now:Date.parse(at),minutes:20,...extras
});
test('watchdog 20-minute default and explicit override never rushes an existing request',()=>{
  assert.equal(codexWatchMinutes(),20);
  assert.equal(codexWatchMinutes('9'),9);
  assert.equal(codexWatchMinutes('bad'),20);
  assert.equal(decision('2026-11-10T10:19:59Z').status,'pending');
  assert.equal(decision('2026-11-10T10:20:00Z').status,'rerequest');
  assert.equal(codexWatchDecision({record:watchdogRecord(),comments:[firstRequest],
    now:Date.parse('2026-11-10T10:09:00Z'),minutes:9}).status,'rerequest');
});
test('review, running bot receipt or connector reaction suppresses retry and escalation',()=>{
  assert.equal(decision('2026-11-10T10:41:00Z',[firstRequest,secondRequest],{
    reviews:[{commit_id:head,user:{login:'chatgpt-codex-connector'}}]}).status,'receipt');
  const running='<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+
    JSON.stringify({code_review:{commit_sha:head,status:'running',has_any_findings:null,
      has_unresolved_findings:null}})+' -->';
  assert.equal(decision('2026-11-10T10:41:00Z',[firstRequest,secondRequest,{
    user:{login:'chatgpt-codex-connector[bot]'},body:running}]).status,'receipt');
  assert.equal(decision('2026-11-10T10:41:00Z',[firstRequest,secondRequest],{
    reactions:[{content:'+1',user:{login:'chatgpt-codex-connector[bot]'}}]}).status,'receipt');
  assert.equal(decision('2026-11-10T10:41:00Z',[firstRequest,secondRequest],{
    reactions:[{content:'+1',user:{login:'some-other-bot'}}]}).status,'escalate');
});
test('exact head and two request ceiling hold after retry, with no third request',()=>{
  assert.equal(decision('2026-11-10T10:40:59Z',[firstRequest,secondRequest]).status,'pending');
  assert.deepEqual(decision('2026-11-10T10:41:00Z',[firstRequest,secondRequest]),
    {status:'escalate',head_sha:head,attempts:2});
  assert.equal(decision('2026-11-10T12:00:00Z',[firstRequest,secondRequest]).status,'escalate');
  const manual={...firstRequest,id:12,body:'@codex review',created_at:'2026-11-10T10:21:00Z'};
  assert.equal(decision('2026-11-10T10:42:00Z',[firstRequest,manual]).status,'escalate');
  assert.equal(codexWatchDecision({record:{...watchdogRecord(),head_sha:'f'.repeat(40)},
    comments:[firstRequest],now:Date.parse('2026-11-10T11:00:00Z')}).status,'held');
  assert.equal(codexWatchDecision({record:{...watchdogRecord(),codex_reviewed_sha:head},
    comments:[firstRequest],now:Date.parse('2026-11-10T11:00:00Z')}).status,'held');
  assert.equal(decision('2026-11-10T11:00:00Z',[{...firstRequest,
    body:'<!-- aicafe-dispatcher-codex-review:'+head+' -->',author_association:'NONE',
    user:{login:'attacker'}}]).status,'no_verified_request');
});
test('watchdog checks GitHub PR head, reviews and comment reactions, then sends one exact retry',async()=>{
  const posted=[], requests=[];
  let replies=[],comments=[firstRequest],prReactions=[];
  const github={
    request:async(path,opts)=>{
      requests.push(path);
      if(path==='/pulls/423') return {state:'open',head:{sha:head}};
      if(path==='/issues/423/comments'&&opts?.method==='POST'){
        const body=JSON.parse(opts.body).body;posted.push(body);return {id:11};
      }
      throw Error('Unexpected GitHub request '+path);
    },
    paginated:async(path)=>{
      if(path==='/issues/423/comments')return comments;
      if(path==='/issues/423/reactions')return prReactions;
      if(path==='/pulls/423/reviews')return [];
      if(path==='/issues/comments/10/reactions')return replies;
      if(path==='/issues/comments/11/reactions')return [];
      throw Error('Unexpected paginated request '+path);
    }
  };
  const now=Date.parse('2026-11-10T10:21:00Z');
  assert.equal((await inspectCodexWatch({github,record:watchdogRecord(),now})).status,'rerequest');
  assert.equal((await rerequestCodexReview({github,record:watchdogRecord(),now})).status,'codex_rerequested');
  assert.equal(posted.length,1);
  assert.match(posted[0],/@codex review/);
  assert.match(posted[0],/aicafe-dispatcher-codex-rerequest:/);
  comments=[firstRequest,secondRequest];
  assert.equal((await rerequestCodexReview({github,record:watchdogRecord(),
    now:Date.parse('2026-11-10T10:42:00Z')})).status,'escalate');
  assert.equal(posted.length,1);
  replies=[{user:{login:'chatgpt-codex-connector[bot]'},content:'+1'}];
  assert.equal((await inspectCodexWatch({github,record:watchdogRecord(),
    now:Date.parse('2026-11-10T10:42:00Z')})).status,'receipt');
  assert.equal(posted.length,1);
  replies=[];
  prReactions=[{content:'+1',user:{login:'chatgpt-codex-connector[bot]'},created_at:'2026-11-10T10:12:00Z'}];
  assert.equal((await inspectCodexWatch({github,record:watchdogRecord(),now:Date.parse('2026-11-10T10:42:00Z')})).status,'receipt');
});
test('watchdog referee uses existing owner-alert queue without a new gate',async()=>{
  const {queueOwnerAlerts}=await import('./alerts.mjs');
  const state={tasks:{child:{pr_number:423,head_sha:head,codex_referee_sha:head}},actions:{}};
  const once=queueOwnerAlerts(state);
  assert.equal(Object.values(once.owner_alerts).filter(n=>n.kind==='codex_watchdog').length,1);
  const twice=queueOwnerAlerts(once);
  assert.equal(Object.values(twice.owner_alerts).filter(n=>n.kind==='codex_watchdog').length,1);
  const newHead=structuredClone(twice);
  newHead.tasks.child.head_sha='f'.repeat(40);
  const refreshed=queueOwnerAlerts(newHead);
  assert.equal(Object.values(refreshed.owner_alerts).filter(n=>n.kind==='codex_watchdog'&&n.status==='planned').length,0);
});
