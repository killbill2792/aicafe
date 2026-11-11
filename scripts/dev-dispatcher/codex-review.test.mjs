import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCodexReview,codexWatchDecision,codexWatchMinutes,inspectCodexWatch } from './codex-review.mjs';
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

test('red/pending CI never requests Codex; green final head requests once',async()=>{
 const gh=fakeGithub(),record=rec();
 assert.equal((await requestCodexReview({github:gh,record:{...record,ci_state:'failure'},task})).status,'held');
 assert.equal((await requestCodexReview({github:gh,record:{...record,ci_state:'pending'},task})).status,'held');
 assert.equal(gh.posted.length,0);
 assert.equal((await requestCodexReview({github:gh,record,task})).status,'requested');
 assert.equal(gh.posted.length,1);
 assert.equal((await requestCodexReview({github:gh,record:{...record,codex_review_requested_sha:head},task})).status,'held');
});
test('dispatcher-only owner-merge PR never requests Codex',async()=>{
 const gh=fakeGithub();
 assert.equal((await requestCodexReview({github:gh,record:{
   ...rec(),adhoc:true,dispatcher_only:true},task:null})).status,'held');
 assert.equal(gh.posted.length,0);
});

const watchRecord=()=>({...rec(),codex_review_requested_sha:head,codex_state:'pending'});
const firstRequest={id:10,created_at:'2026-11-10T10:00:00Z',author_association:'OWNER',
 user:{login:'killbill2792'},body:'@codex review\n<!-- aicafe-dispatcher-codex-review:'+head+' -->'};
const decision=(at,extras={})=>codexWatchDecision({record:watchRecord(),comments:[firstRequest],
 now:Date.parse(at),...extras});
test('watchdog times out once to referee without ever issuing another request',()=>{
 assert.equal(codexWatchMinutes(),20);
 assert.equal(codexWatchMinutes('9'),9);
 assert.equal(codexWatchMinutes('invalid'),20);
 assert.equal(decision('2026-11-10T10:19:59Z').status,'pending');
 assert.deepEqual(decision('2026-11-10T10:20:00Z'),{status:'escalate',head_sha:head});
 assert.equal(decision('2026-11-10T10:30:00Z').status,'escalate');
 assert.equal(decision('2026-11-10T10:09:00Z',{minutes:9}).status,'escalate');
});
test('Codex review, running summary and exact GitHub reaction suppress escalation',()=>{
 assert.equal(decision('2026-11-10T11:00:00Z',{reviews:[{commit_id:head,
  user:{login:'chatgpt-codex-connector'}}]}).status,'receipt');
 const running='<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+JSON.stringify({code_review:
   {commit_sha:head,status:'running',has_any_findings:null,has_unresolved_findings:null}})+' -->';
 assert.equal(decision('2026-11-10T11:00:00Z',{comments:[firstRequest,
  {user:{login:'chatgpt-codex-connector[bot]'},body:running}]}).status,'receipt');
 assert.equal(decision('2026-11-10T11:00:00Z',{reactions:[{
  user:{login:'chatgpt-codex-connector[bot]'},content:'eyes'}]}).status,'receipt');
 assert.equal(decision('2026-11-10T11:00:00Z',{reactions:[{
  user:{login:'other-bot'},content:'eyes'}]}).status,'escalate');
});
test('unverified commenter and changed SHA never justify a watchdog alert',()=>{
 const fake={...firstRequest,user:{login:'stranger'},author_association:'NONE'};
 assert.equal(decision('2026-11-10T11:00:00Z',{comments:[fake]}).status,'no_verified_request');
 assert.equal(decision('2026-11-10T11:00:00Z',{record:{...watchRecord(),head_sha:'f'.repeat(40)}}).status,'held');
 assert.equal(decision('2026-11-10T11:00:00Z',{record:{...watchRecord(),codex_reviewed_sha:head}}).status,'held');
});
test('GitHub watchdog inspects receipts and never POSTs another Codex request',async()=>{
 let posts=0,reactions=[];
 const gh={request:async(path,opts)=>{
  if(opts?.method==='POST')posts++;
  if(path==='/pulls/423')return {state:'open',head:{sha:head}};
  throw Error('Unexpected GitHub request '+path);
 },paginated:async path=>{
  if(path==='/issues/423/comments')return [firstRequest];
  if(path==='/pulls/423/reviews')return [];
  if(path==='/issues/423/reactions')return reactions;
  if(path==='/issues/comments/10/reactions')return [];
  throw Error('Unexpected paginated request '+path);
 }};
 const at=Date.parse('2026-11-10T11:00:00Z');
 assert.equal((await inspectCodexWatch({github:gh,record:watchRecord(),now:at})).status,'escalate');
 reactions=[{user:{login:'chatgpt-codex-connector[bot]'},content:'+1',
  created_at:'2026-11-10T10:21:00Z'}];
 assert.equal((await inspectCodexWatch({github:gh,record:watchRecord(),now:at})).status,'receipt');
 assert.equal(posts,0);
});

test('automatic green Ready transition times out without a manual review comment',()=>{
 const record={...watchRecord(),ready_transition_at:'2026-11-10T10:00:00Z'};
 const check=at=>codexWatchDecision({record,comments:[],now:Date.parse(at)});
 assert.equal(check('2026-11-10T10:19:59Z').status,'pending');
 assert.deepEqual(check('2026-11-10T10:20:00Z'),{status:'auto_review_missing',head_sha:head});
 assert.equal(codexWatchDecision({record,comments:[],reviews:[{
  commit_id:head,user:{login:'chatgpt-codex-connector[bot]'}}],
  now:Date.parse('2026-11-10T10:21:00Z')}).status,'receipt');
 assert.equal(codexWatchDecision({record:{...record,ready_transition_at:null},
  comments:[],now:Date.parse('2026-11-10T11:00:00Z')}).status,'no_verified_request');
});
test('watchdog observes exact GitHub Ready state and never posts a duplicate trigger',async()=>{
 const record={...watchRecord(),ready_transition_at:'2026-11-10T10:00:00Z'};
 let posted=0;
 const gh={request:async(path,options)=>{
  if(options?.method==='POST')posted++;
  assert.equal(path,'/pulls/423');
  return {state:'open',draft:false,head:{sha:head}};
 },paginated:async path=>{
  if(['/issues/423/comments','/pulls/423/reviews','/issues/423/reactions'].includes(path))return [];
  throw Error('Unexpected receipt path '+path);
 }};
 const result=await inspectCodexWatch({github:gh,record,now:Date.parse('2026-11-10T10:21:00Z')});
 assert.deepEqual(result,{status:'auto_review_missing',head_sha:head});assert.equal(posted,0);
});

test('a missed automatic Ready event permits ONE verified explicit fallback on the same green head',async()=>{
 const github=fakeGithub();
 const record={...rec(),ready_transition_at:'2026-11-10T10:00:00Z',
   codex_review_requested_sha:head,codex_state:'pending'};
 assert.equal((await requestCodexReview({github,record,task})).status,'held');
 assert.deepEqual(await requestCodexReview({github,record,task,autoMissFallback:true}),
   {status:'requested',head_sha:head});
 assert.equal(github.posted.length,1);
 assert.match(github.posted[0],/@codex review/);
 const repeated=await requestCodexReview({github,record:{...record,
   codex_fallback_requested_sha:head},task,autoMissFallback:true});
 assert.equal(repeated.status,'held');
 assert.equal(github.posted.length,1);
});
test('Codex fallback fails closed on red/pending CI, stale SHA, draft and already running review',async()=>{
 for(const changes of [{ci_state:'failure'},{ci_state:'pending'},
   {draft:true},{ready_transition_at:null},
   {codex_reviewed_sha:head},{codex_in_progress_sha:head}]){
  const gh=fakeGithub();
  const record={...rec(),ready_transition_at:'2026-11-10T10:00:00Z',
    codex_review_requested_sha:head,...changes};
  const outcome=await requestCodexReview({github:gh,record,task,autoMissFallback:true});
  assert.equal(outcome.status,'held');
  assert.equal(gh.posted.length,0);
 }
 const stale=fakeGithub();
 stale.request=async path=>({state:'open',draft:false,head:{sha:'f'.repeat(40)}});
 assert.equal((await requestCodexReview({github:stale,
   record:{...rec(),ready_transition_at:'2026-11-10T10:00:00Z',
     codex_review_requested_sha:head},task,autoMissFallback:true})).status,'stale');
});
test('a late explicit request restarts the 20-minute Codex watchdog instead of escalating immediately',()=>{
 const record={...watchRecord(),ready_transition_at:'2026-11-10T10:00:00Z',
   codex_fallback_requested_sha:head};
 const c={...firstRequest,created_at:'2026-11-10T10:20:00Z'};
 assert.equal(codexWatchDecision({record,comments:[c],now:Date.parse('2026-11-10T10:25:00Z')}).status,'pending');
 assert.equal(codexWatchDecision({record,comments:[c],now:Date.parse('2026-11-10T10:40:00Z')}).status,'escalate');
});
