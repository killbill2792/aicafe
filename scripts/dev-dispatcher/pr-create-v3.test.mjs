import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureApprovedDraftPr,classifyPrCreatePreflightError} from './pr-create-v3.mjs';
import {approvalSignature} from './delivery.mjs';
import {GitHubFacts,parseChatMarker,parseTaskMarker} from './github.mjs';
import {recordGithubEffects} from './github-effects-v3.mjs';
const head='a'.repeat(40),base='b'.repeat(40),branch='feat/aicafe-task-E2';
const task={id:'E2',title:'Browser coverage',state:'ready',depends_on:[],
  architecture_approval:{approved:true},edits:['scripts/e2e/smoke.mjs'],
  acceptance:['CI actual browser test'],brief:'docs/plans/brief.md'};
const rec={task_id:'E2',approved:true,branch,base_branch:'main',prerequisite_pr:null,
  conversation_ref:'https://chatgpt.com/c/abc-123',approval_hash:approvalSignature(task)};
function setup({files=['scripts/e2e/smoke.mjs'],old=[],changedHead=false,writeFails=false}={}){
 const seen=[],github={request:async uri=>{
  seen.push(uri);
  if(uri.startsWith('/git/ref/heads/'))return {object:{sha:changedHead&&seen.filter(x=>x.startsWith('/git/ref')).length>1?base:head}};
  if(uri.startsWith('/pulls?'))return old;
  if(uri.startsWith('/compare/'))return {ahead_by:1,files:files.map(file=>typeof file==='string'?{filename:file}:file)};
  throw Error('Unexpected GitHub request '+uri);
 }};
 const writer={request:async(uri,opts)=>{
  seen.push(uri);
  assert.equal(uri,'/pulls');
  const data=JSON.parse(opts.body);
  assert.equal(data.draft,true);assert.equal(data.head,branch);assert.equal(data.base,'main');
  assert.equal(parseTaskMarker(data.body),'E2');
  assert.equal(parseChatMarker(data.body),rec.conversation_ref);
  if(writeFails)throw Error('Synthetic network timeout');
  return {state:'open',draft:true,number:450,head:{sha:head}};
 }};
 return {github,writer,seen};
}
test('approved delivered branch with exact signed edits creates early draft PR',async()=>{
 const {github,writer,seen}=setup();
 const result=await ensureApprovedDraftPr({github,writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'created');
 assert.equal(result.pr_number,450);
 assert.equal(seen.filter(x=>x==='/pulls').length,1);
});
test('unknown chat or modified approval never creates a PR',async()=>{
 const {github,writer,seen}=setup();
 for(const r of [{...rec,conversation_ref:null},{...rec,approval_hash:'f'.repeat(64)},
   {...rec,approved:false},{...rec,branch:'wrong-branch'}]){
  const result=await ensureApprovedDraftPr({github,writer,task,record:r,verifiedDelivery:true});
  assert.equal(result.status,'blocked');
 }
 assert.equal(seen.length,0);
});
test('never creates from unsigned edits or a changed head',async()=>{
 const a=setup({files:['scripts/e2e/smoke.mjs','lib/unauthorized.ts']});
 const result=await ensureApprovedDraftPr({github:a.github,writer:a.writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.reason,'branch_contains_unsigned_edits');
 assert.ok(!a.seen.includes('/pulls'));
 const b=setup({changedHead:true});
 const other=await ensureApprovedDraftPr({github:b.github,writer:b.writer,task,record:rec,verifiedDelivery:true});
 assert.equal(other.reason,'head_changed_during_preflight');
 assert.ok(!b.seen.includes('/pulls'));
});
test('existing PR is linked for reconciliation instead of a duplicate write',async()=>{
 const a=setup({old:[{number:440,state:'open',draft:true,head:{ref:branch,sha:head}}]});
 const result=await ensureApprovedDraftPr({github:a.github,writer:a.writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'existing_pr_needs_link');
 assert.equal(result.pr_number,440);
 assert.ok(!a.seen.includes('/pulls'));
});
test('uncertain create response never triggers blind retry',async()=>{
 const a=setup({writeFails:true});
 const result=await ensureApprovedDraftPr({github:a.github,writer:a.writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'uncertain');
 assert.equal(a.seen.filter(x=>x==='/pulls').length,1);
});
test('wrong parent base cannot create an unauthorized PR',async()=>{
 const a=setup();
 const withDeps={...task,depends_on:['parent']};
 const signed={...rec,approval_hash:approvalSignature(withDeps)};
 const result=await ensureApprovedDraftPr({github:a.github,writer:a.writer,
  task:withDeps,record:signed,verifiedDelivery:true,records:{}});
 assert.equal(result.reason,'wrong_or_unverified_parent_base');
 assert.equal(a.seen.length,0);
});


test('no authenticated Muse coding-delivery receipt means no automatic PR',async()=>{
 const a=setup();
 const result=await ensureApprovedDraftPr({github:a.github,writer:a.writer,
  task,record:rec,verifiedDelivery:false});
 assert.equal(result.reason,'signed_scope_or_chat_unverified');
 assert.equal(a.seen.length,0);
});


test('GitHub PR-create 403 is a visible permission blocker, not an uncertain POST',async()=>{
 const a=setup();
 const writer={request:async()=>{throw Error('GitHub request failed: status=403 message=Resource not accessible by integration');}};
 const result=await ensureApprovedDraftPr({github:a.github,writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'blocked');
 assert.equal(result.reason,'pr_creator_permission_denied');
});
test('GitHub PR-create API rate limit is separately classified',async()=>{
 const a=setup();
 const writer={request:async()=>{const e=Error('GitHub request failed: status=429');e.code='RATE_LIMIT';throw e;}};
 const result=await ensureApprovedDraftPr({github:a.github,writer,task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'blocked');
 assert.equal(result.reason,'github_rate_limited');
});


test('real GitHubFacts 404 for an unpushed branch is an ordinary blocked result',async()=>{
 const gh=new GitHubFacts({repo:'killbill2792/aicafe',token:'fake-testing-token',
   fetchFn:async()=>({ok:false,status:404,headers:{get:()=>null},
     json:async()=>({message:'Not Found'})}),sleepFn:async()=>{}});
 let writes=0;
 const writer={request:async()=>{writes++;throw Error('Unexpected PR creation');}};
 const result=await ensureApprovedDraftPr({github:gh,writer,task,record:rec,
   verifiedDelivery:true});
 assert.equal(result.status,'blocked');
 assert.equal(result.reason,'branch_missing');
 assert.equal(writes,0);
});
test('rename into signed path cannot delete unapproved source',async()=>{
 const mock=setup({files:[{status:'renamed',filename:'scripts/e2e/smoke.mjs',
   previous_filename:'lib/unsigned-old.ts'}]});
 const result=await ensureApprovedDraftPr({github:mock.github,writer:mock.writer,
   task,record:rec,verifiedDelivery:true});
 assert.equal(result.status,'blocked');
 assert.equal(result.reason,'branch_contains_unsigned_edits');
 assert.deepEqual(result.files,['lib/unsigned-old.ts']);
 assert.equal(mock.calls?.writes||mock.seen.filter(x=>x==='/pulls').length,0);
});
test('rename without verified source is blocked rather than guessing authorization',async()=>{
 const mock=setup({files:[{status:'renamed',filename:'scripts/e2e/smoke.mjs'}]});
 const result=await ensureApprovedDraftPr({github:mock.github,writer:mock.writer,
   task,record:rec,verifiedDelivery:true});
 assert.equal(result.reason,'no_verified_complete_changed_file_list');
 assert.ok(!mock.seen.includes('/pulls'));
});
test('rename where both old and new file paths are signed may create a draft',async()=>{
 const signedTask={...task,edits:[...task.edits,'lib/old.ts']};
 const signedRecord={...rec,approval_hash:approvalSignature(signedTask)};
 const mock=setup({files:[{status:'renamed',filename:'scripts/e2e/smoke.mjs',
   previous_filename:'lib/old.ts'}]});
 const result=await ensureApprovedDraftPr({github:mock.github,writer:mock.writer,
   task:signedTask,record:signedRecord,verifiedDelivery:true});
 assert.equal(result.status,'created');
 assert.equal(mock.seen.filter(x=>x==='/pulls').length,1);
});


test('two successive uncertain PR creates never replay a write when PR discovery remains empty',async()=>{
 const first=setup({writeFails:true});
 const initial=await ensureApprovedDraftPr({github:first.github,writer:first.writer,
   task,record:rec,verifiedDelivery:true});
 assert.equal(initial.status,'uncertain');
 assert.equal(first.seen.filter(x=>x==='/pulls').length,1);
 const snapshot={version:1,actions:{},tasks:{E2:{...rec,head_sha:head}}};
 const persisted=recordGithubEffects(snapshot,[{task_id:'E2',
   operation:'CREATE_DRAFT_PR',status:initial.status,
   reason:initial.reason,head_sha:head}],'2026-11-11T10:00:00Z');
 assert.ok(persisted.tasks.E2.pr_creation_uncertain_hold);
 const second=setup({writeFails:true});
 const next=await ensureApprovedDraftPr({github:second.github,writer:second.writer,
   task,record:persisted.tasks.E2,records:persisted.tasks,verifiedDelivery:true});
 assert.equal(next.status,'uncertain');
 assert.equal(next.reason,'previous_pr_creation_write_unverified');
 assert.ok(second.seen.some(x=>x.startsWith('/pulls?')));
 assert.ok(!second.seen.includes('/pulls'),'No second POST after uncertain effect');
 assert.ok(!second.seen.some(x=>x.startsWith('/compare/')),
   'No need to revalidate a write that remains forbidden');
});
test('a verified existing PR resolves an uncertain creation without another POST',async()=>{
 const mock=setup({old:[{number:450,state:'open',draft:true,
   head:{ref:branch,sha:head}}]});
 const held={...rec,pr_creation_uncertain_hold:{attempted_head_sha:head}};
 const result=await ensureApprovedDraftPr({github:mock.github,writer:mock.writer,
   task,record:held,verifiedDelivery:true});
 assert.equal(result.status,'existing_pr_needs_link');
 assert.equal(result.pr_number,450);
 assert.equal(mock.seen.filter(x=>x==='/pulls').length,0);
});


test('temporary preflight 503 never latches a PR write and recovers after reads return',async()=>{
 let reads=0,writes=0;
 const unavailable=new GitHubFacts({repo:'killbill2792/aicafe',token:'test',
   fetchFn:async()=>{reads++;return {ok:false,status:503,
     headers:{get:()=>null},json:async()=>({message:'Service Unavailable'})};},
   sleepFn:async()=>{}});
 const writer={request:async()=>{writes++;throw Error('POST must not run on failed preflight');}};
 let failure;
 try{await ensureApprovedDraftPr({github:unavailable,writer,task,record:rec,
   verifiedDelivery:true});}catch(error){failure=error;}
 assert.equal(failure?.status,503);
 assert.equal(reads,3,'bounded GET retries only');
 assert.equal(writes,0);
 const classified=classifyPrCreatePreflightError(failure);
 assert.deepEqual(classified,{status:'blocked',reason:'github_pr_preflight_read_unavailable'});
 const state={version:1,actions:{},tasks:{E2:{...rec,head_sha:head}}};
 const observed=recordGithubEffects(state,[{task_id:'E2',operation:'CREATE_DRAFT_PR',
   head_sha:head,...classified}],'2026-11-11T10:00:00Z');
 assert.equal(observed.tasks.E2.pr_creation_uncertain_hold,undefined);
 const healthy=setup();
 const result=await ensureApprovedDraftPr({github:healthy.github,writer:healthy.writer,
   task,record:observed.tasks.E2,records:observed.tasks,verifiedDelivery:true});
 assert.equal(result.status,'created');
 assert.equal(healthy.seen.filter(x=>x==='/pulls').length,1);
});
test('preflight permission and rate-limit failures are blocked reads, not uncertain writes',()=>{
 assert.deepEqual(classifyPrCreatePreflightError({status:403}),{
   status:'blocked',reason:'github_pr_preflight_read_permission_denied'});
 assert.deepEqual(classifyPrCreatePreflightError({code:'RATE_LIMIT',status:429}),{
   status:'blocked',reason:'github_rate_limited'});
});
