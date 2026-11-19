import test from 'node:test';
import assert from 'node:assert/strict';
import {museActions,normalizeGithubFacts,fetchGithubFacts,reserveMuseActions,runMuseLite,observeHandoffRuns,completeOwnerRequestPages} from './muse-lite.mjs';
import {readMuseQuestions,syncMuseQuestions,writeMuseQuestion,importMuseQuestions} from './muse-owner-questions.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const now='2026-11-16T20:00:00Z',sha='a'.repeat(40);
const c=(head=sha,hasFindings=false)=>({body:
 '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+JSON.stringify({code_review:{commit_sha:head,
  has_any_findings:hasFindings,has_unresolved_findings:hasFindings,status:'completed'}})+' -->',
 author:{login:'chatgpt-codex-connector[bot]'}});
const github=(state='SUCCESS',comments=[c()])=>({data:{repository:{
 nameWithOwner:'killbill2792/aicafe',
 pullRequests:{pageInfo:{hasNextPage:false},nodes:[{
  number:488,title:'Proactive investigations',url:'https://github.com/killbill2792/aicafe/pull/488',
  isDraft:false,headRefOid:sha,authorAssociation:'OWNER',body:'',
  headRepository:{nameWithOwner:'killbill2792/aicafe'},
  labels:{pageInfo:{hasNextPage:false},nodes:[]},
  headRef:{target:{committedDate:'2026-11-16T19:40:00Z',
   statusCheckRollup:{state}}},
  comments:{pageInfo:{hasPreviousPage:false},nodes:comments}
 }]},recentlyMerged:{nodes:[]}}}});
const notes=(stage='working',url='https://chatgpt.com/c/1234')=>({version:1,entries:{
 '15a':{task_id:'15a',pr_number:488,chat_url:url,stage,
  note:'Continue review',updated_at:'2026-11-16T19:45:00Z',revision:1}
}});
const previous={version:1,observed_at:'2026-11-16T19:50:00Z',
 prs:[{number:488,head_sha:sha}],merged_prs:[]};

test('one read-only GraphQL response provides current PR and exact-head Codex state',()=>{
 const v=normalizeGithubFacts(github(),now);
 assert.equal(v.prs.length,1);
 assert.equal(v.prs[0].ci,'observed_green');
 assert.equal(v.prs[0].codex,'clean');
 assert.equal(v.prs[0].head_sha,sha);
 const old=normalizeGithubFacts(github('SUCCESS',[c('b'.repeat(40))]),now);
 assert.equal(old.prs[0].codex,'unknown');
 assert.equal(normalizeGithubFacts(github('FAILURE',[c(sha,true)]),now).prs[0].codex,'findings');
 for(const login of ['chatgpt-codex-connector','codex','codex[bot]']){
  const bot=c();bot.author.login=login;
  assert.equal(normalizeGithubFacts(github('SUCCESS',[bot]),now).prs[0].codex,'clean',login);
  const finding=c(sha,true);finding.author.login=login;
  assert.equal(normalizeGithubFacts(github('SUCCESS',[finding]),now).prs[0].codex,'findings',login);
  const running=c();running.author.login=login;running.body=running.body.replace('"status":"completed"','"status":"running"');
  assert.equal(normalizeGithubFacts(github('PENDING',[running]),now).prs[0].codex,'pending',login);
 }
 const spoof=c();spoof.author.login='untrusted-contributor';
 assert.equal(normalizeGithubFacts(github('SUCCESS',[spoof]),now).prs[0].codex,'unknown');
});
test('incomplete PR pagination and GraphQL error cannot claim all checks green',()=>{
 const truncated=github();truncated.data.repository.pullRequests.pageInfo.hasNextPage=true;
 assert.throws(()=>normalizeGithubFacts(truncated,now),/Incomplete/);
 assert.throws(()=>normalizeGithubFacts({errors:[{message:'rate limit'}]},now),/Incomplete/);
});
test('failed check and Codex finding produce repair action, not merge',()=>{
 const failing=normalizeGithubFacts(github('FAILURE',[c(sha,true)]),now);
 assert.deepEqual(museActions(failing,previous,notes(),{now}).actions.map(a=>a.kind),['fix_ci']);
 const review=normalizeGithubFacts(github('SUCCESS',[c(sha,true)]),now);
 assert.deepEqual(museActions(review,previous,notes(),{now}).actions.map(a=>a.kind),
  ['fix_codex']);
});
test('verified green checks and clean Codex only request ChatGPT to verify merge gates',()=>{
 const facts=normalizeGithubFacts(github(),now);
 const out=museActions(facts,previous,notes(),{now});
 assert.deepEqual(out.actions.map(a=>a.kind),['verify_merge']);
 assert.match(out.actions[0].reason,/only if eligible/);
 assert.equal(out.actions[0].chat_url,'https://chatgpt.com/c/1234');
});
test('idle only nudges once per head; pending work and owner holds suppress it',()=>{
 const unknown=normalizeGithubFacts(github(null,[]),now);
 assert.equal(museActions(unknown,previous,notes(),{now}).actions[0].kind,'continue_chat');
 const first=reserveMuseActions(null,museActions(unknown,previous,notes(),{now}),now);
 assert.equal(first.new_actions.length,1);
 assert.equal(reserveMuseActions(first.state,museActions(unknown,previous,notes(),{now}),
   '2026-11-16T20:10:00Z').new_actions.length,0);
 const pending=normalizeGithubFacts(github('PENDING',[]),now);
 assert.equal(museActions(pending,previous,notes(),{now}).actions.length,0);
 assert.equal(museActions(unknown,previous,notes('paused'),{now}).actions.length,0);
 assert.equal(museActions(unknown,previous,notes('waiting_owner'),{now}).actions.length,1);
 assert.equal(museActions(unknown,previous,notes('waiting_owner'),{now}).actions[0].kind,
   'continue_chat');
});
test('missing chat URL blocks sending and GitHub outage keeps local owner reminder',()=>{
 const facts=normalizeGithubFacts(github(),now);
 const missing=museActions(facts,previous,notes('working',''),{now});
 assert.equal(missing.actions.length,0);
 assert.equal(missing.blocked[0].reason,'missing_verified_chat_url');
 const planning=notes('waiting_owner');planning.entries['15a'].pr_number=null;
 const offline=museActions(null,previous,planning,{now});
 assert.equal(offline.fresh,false);
 assert.equal(offline.actions[0].kind,'remind_owner');
 assert.equal(offline.actions[0].chat_url,'https://chatgpt.com/c/1234');
 assert.equal(offline.blocked[0].reason,'github_evidence_stale_or_unavailable');
});
test('closed or missing PR stays visible as a coordination blocker',()=>{
 const facts=normalizeGithubFacts(github(),now);
 facts.prs=[];
 const result=museActions(facts,previous,notes(),{now});
 assert.equal(result.actions.length,0);
 assert.equal(result.blocked[0].reason,'pr_missing_or_closed_unmerged_verify_github');
});
test('newly verified merge is offered once; never infer merge from missing PR',()=>{
 const facts=normalizeGithubFacts(github(),now);
 facts.prs=[];
 facts.merged_prs=[{number:488,merged_at:'2026-11-16T19:58:00Z'}];
 assert.equal(museActions(facts,previous,notes(),{now}).actions[0].kind,'plan_next');
 assert.equal(museActions({...facts,merged_prs:[]},previous,notes(),{now}).actions.length,0);
 assert.equal(museActions(facts,{version:1,prs:[]},notes(),{now}).actions.length,0);
});
test('API failure is not a green status; token only performs read-only GraphQL',async()=>{
 let calls=0;
 const v=await fetchGithubFacts({repo:'killbill2792/aicafe',token:'read-only-token',now,
  fetchImpl:async(url,opts)=>{
   calls++;
   assert.equal(url,'https://api.github.com/graphql');
   assert.equal(opts.method,'POST');
   assert.ok(!opts.body.includes('mutation'));
   return {ok:true,json:async()=>github()};
  }});
 assert.equal(calls,1);
 assert.equal(v.prs[0].codex,'clean');
 await assert.rejects(fetchGithubFacts({repo:'killbill2792/aicafe',token:'token',now,
  fetchImpl:async()=>({ok:false,status:429})}),/GitHub read unavailable/);
});

test('one GitHub outage creates local cooldown, preserves state and suppresses repeated reads',async()=>{
 const home=mkdtempSync(join(tmpdir(),'muse-watch-'));
 try{
  let calls=0;
  const fake=async()=>{calls++;return {ok:false,status:429};};
  const first=await runMuseLite({repo:'killbill2792/aicafe',token:'read-only-token',
   home,now,fetchImpl:fake});
  assert.equal(first.github_read,'unavailable');
  assert.equal(first.actions.length,0);
  assert.equal(first.holds[0].reason,'github_evidence_stale_or_unavailable');
  const second=await runMuseLite({repo:'killbill2792/aicafe',token:'read-only-token',
   home,now:'2026-11-16T20:05:00Z',fetchImpl:fake});
  assert.equal(second.github_read,'unavailable');
  assert.equal(calls,1,'local cooldown must suppress repeat GitHub API calls');
 }finally{rmSync(home,{recursive:true,force:true});}
});

const request=(id,question,head=sha)=>({body:'<!-- aicafe-owner-request:v1 '+head+' -->\n'+question,
 authorAssociation:'OWNER',author:{login:'maintainer'},createdAt:now,url:'https://github.com/killbill2792/aicafe/pull/488#issuecomment-'+id});
const empty=()=>({version:1,entries:{}});
const factsWith=(...comments)=>normalizeGithubFacts(github('SUCCESS',comments),now);
test('all trusted distinct comments are imported; no chat URL or label needed',()=>{
 const a=request(101,'Approve architecture?'),b=request(102,'Authorize one $0.20 Luna test?');
 const facts=factsWith(a,b),questions=importMuseQuestions(empty(),facts,now);
 const out=museActions(facts,previous,empty(),{now,questions});
 assert.equal(out.actions.length,2);
 assert.equal(out.actions[0].question_id,'comment-101');
 assert.equal(out.actions[0].chat_url,null);
 assert.equal(out.actions[1].reason,'Authorize one $0.20 Luna test?');
 assert.equal(out.actions[1].pr_url,b.url);
 assert.deepEqual(importMuseQuestions(questions,facts,now),questions);
 assert.deepEqual(importMuseQuestions(questions,null,now),questions);
});
test('question history persists across polls, answer, restart and second request; no mutation of GitHub',()=>{
 const dir=mkdtempSync(join(tmpdir(),'muse-questions-')),path=join(dir,'owner-questions.json');
 try{
  const facts=factsWith(request(101,'Approve architecture?'));
  let state=syncMuseQuestions(path,facts,now);
  const edit=(action,detail,revision=state.entries['comment-101'].revision)=>writeMuseQuestion(path,
   {id:'comment-101',expected_revision:revision,action,detail},{role:'muse',now,notes:notes()});
  state=edit('answer','Owner said yes to this scope only');
  assert.equal(state.entries['comment-101'].status,'answered');
  assert.throws(()=>edit('answer','Overwrite',1),/conflict/);
  state=syncMuseQuestions(path,facts,now);
  assert.equal(state.entries['comment-101'].answer,'Owner said yes to this scope only');
  state=edit('claim_delivery','Going to send answer to registered chat');
  assert.equal(state.entries['comment-101'].status,'delivery_uncertain');
  assert.throws(()=>edit('claim_delivery','duplicate'),/transition/);
  state=edit('confirm_delivery','Observed message accepted in registered chat');
  state=edit('close','Original question answered; continue coding');
  state=syncMuseQuestions(path,factsWith(request(101,'Approve architecture?'),request(102,'Luna approval?')),now);
  assert.equal(state.entries['comment-101'].status,'closed');
  assert.equal(readMuseQuestions(path).entries['comment-102'].status,'open');
  const out=museActions(facts,previous,notes(),{now,questions:state});
  assert.deepEqual(out.actions.map(a=>a.question_id),['comment-102']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('edited source cannot replace prior question; spoof and untrusted URLs rejected',()=>{
 const original=factsWith(request(101,'Approve A?'));
 let q=importMuseQuestions(empty(),original,now);
 q=importMuseQuestions(q,factsWith(request(101,'Approve B?')),now);
 assert.equal(q.entries['comment-101'].question,'Approve A?');
 assert.equal(q.entries['comment-101'].source_changed,true);
 const spoof={...request(102,'Untrusted'),authorAssociation:'NONE'};
 const bot={...request(103,'Bot'),author:{login:'fake[bot]'}};
 const wrong={...request(104,'Wrong PR'),url:'https://github.com/else/repo/pull/3#issuecomment-104'};
 assert.equal(factsWith(spoof,bot,wrong).prs[0].owner_requests.length,0);
});
test('earlier comment pages are imported and incomplete scan remains visible',async()=>{
 const raw=github('SUCCESS',[request(102,'Second')]),p=raw.data.repository.pullRequests.nodes[0];
 p.comments.pageInfo={hasPreviousPage:true,startCursor:'old'};
 const incomplete=normalizeGithubFacts(raw,now);
 assert.equal(incomplete.prs[0].owner_request_read_incomplete,true);
 for(const stage of ['working','waiting_owner']){
  const out=museActions(incomplete,previous,notes(stage),{now});
  assert.equal(out.actions.length,0);
  assert.match(out.blocked[0].reason,/scan incomplete/);
 }
 const missing=structuredClone(incomplete);delete missing.prs[0].owner_request_read_incomplete;
 assert.equal(museActions(missing,previous,notes(),{now}).actions.length,0);
 await completeOwnerRequestPages(raw,async(n,cursor)=>{
  assert.equal(n,488);assert.equal(cursor,'old');
  return {data:{repository:{pullRequest:{comments:{nodes:[request(101,'First')],pageInfo:{hasPreviousPage:false}}}}}};
 });
 assert.deepEqual(normalizeGithubFacts(raw,now).prs[0].owner_requests.map(q=>q.id),['comment-101','comment-102']);
 assert.equal(normalizeGithubFacts(raw,now).prs[0].owner_request_read_incomplete,false);
});
test('same-head CI completion wakes the coder immediately rather than waiting 10 minutes',()=>{
 const facts=normalizeGithubFacts(github('SUCCESS',[]),now);
 facts.prs[0].committed_at='2026-11-16T19:59:30Z';
 const earlier=structuredClone(facts);earlier.prs[0].ci='pending';
 const out=museActions(facts,earlier,notes(),{now});
 assert.equal(out.actions.length,1);
 assert.equal(out.actions[0].kind,'continue_chat');
 assert.match(out.actions[0].reason,/CI completed green/);
});

const runUrl='https://github.com/killbill2792/aicafe/actions/runs/123456';
function handoffFacts(state,ci='SUCCESS',overrides={},comments=[]){
 const raw=github(ci,comments),p=raw.data.repository.pullRequests.nodes[0];
 p.body='<!-- aicafe-workflow-handoff '+JSON.stringify({id:'attempt-1',head:sha,state,
  run_url:state==='waiting_luna'?runUrl:null,next:'verify the result and continue',...overrides})+' -->';
 return normalizeGithubFacts(raw,now);
}
test('published CI handoff resumes on the first terminal observation, even after monitor restart',()=>{
 const pending=handoffFacts('waiting_ci','PENDING');
 assert.equal(museActions(pending,previous,notes(),{now}).actions.length,0);
 const green=handoffFacts('waiting_ci','SUCCESS');
 const res=museActions(green,null,notes(),{now});
 assert.equal(res.actions[0].kind,'continue_chat');
 const first=reserveMuseActions(null,res,now);
 assert.equal(first.new_actions.length,1);
 assert.equal(reserveMuseActions(first.state,res,now).new_actions.length,0);
 assert.equal(museActions(handoffFacts('waiting_ci','FAILURE'),null,notes(),{now}).actions[0].kind,'fix_ci');
});
test('explicit same-head Codex wait resumes only on actual review evidence',()=>{
 const pending=c();pending.body=pending.body.replace('"status":"completed"','"status":"running"');
 assert.equal(museActions(handoffFacts('waiting_codex','SUCCESS',{},[pending]),null,notes(),{now}).actions.length,0);
 assert.equal(museActions(handoffFacts('waiting_codex','SUCCESS',{},[c('b'.repeat(40))]),null,notes(),{now}).actions.length,0);
 assert.equal(museActions(handoffFacts('waiting_codex','SUCCESS',{},[c()]),null,notes(),{now}).actions[0].kind,'continue_chat');
 assert.equal(museActions(handoffFacts('waiting_codex','SUCCESS',{},[c(sha,true)]),null,notes(),{now}).actions[0].kind,'fix_codex');
});
test('shared Luna is independent of green PR CI and only resumes on the named observed terminal run',async()=>{
 const facts=handoffFacts('waiting_luna'),h=facts.prs[0].workflow_handoff;
 const run={id:123456,html_url:runUrl,name:'AI CAFE Shared Owner-Gated Luna Scenarios',status:'in_progress'};
 assert.equal(museActions(facts,null,notes(),{now}).actions.length,0);
 await observeHandoffRuns(facts,async id=>{assert.equal(id,'123456');return run;});
 assert.equal(h.observed,'pending');
 assert.equal(museActions(facts,null,notes(),{now}).actions.length,0);
 await observeHandoffRuns(facts,async()=>({...run,id:999,status:'completed',conclusion:'success'}));
 assert.equal(h.observed,'unknown');
 assert.equal(museActions(facts,null,notes(),{now}).actions.length,0);
 await observeHandoffRuns(facts,async()=>({...run,status:'completed',conclusion:'failure'}));
 const res=museActions(facts,null,notes(),{now});
 assert.equal(res.actions[0].kind,'continue_chat');
 assert.match(res.actions[0].reason,/completed \(failure\).*verify actual artifacts/);
 const first=reserveMuseActions(null,res,now);
 assert.equal(reserveMuseActions(first.state,res,now).new_actions.length,0);
 await observeHandoffRuns(facts,async()=>{throw Error('429');});
 assert.equal(h.observed,'unknown');
 assert.equal(museActions(facts,null,notes(),{now}).actions.length,0);
});
test('handoffs cannot select another repo run or be inherited onto changed HEAD',()=>{
 for(const overrides of [{head:'b'.repeat(40)},{run_url:'https://example.com/actions/runs/123456'},{run_url:'https://github.com/someone/else/actions/runs/123456'},{run_url:null}]){
  assert.equal(handoffFacts('waiting_luna','SUCCESS',overrides).prs[0].workflow_handoff,null);
 }
});
test('removal or outage never implies answer; missing publication triggers recovery without inventing a question',()=>{
 const facts=factsWith(request(101,'Approve A?'));
 const questions=importMuseQuestions(empty(),facts,now);
 const after=normalizeGithubFacts(github('SUCCESS',[]),now);
 assert.equal(importMuseQuestions(questions,after,now).entries['comment-101'].status,'open');
 assert.equal(museActions(null,facts,notes(),{now,questions}).actions[0].kind,'remind_owner');
 const actions=museActions(after,previous,notes('waiting_owner'),{now}).actions;
 assert.equal(actions[0].kind,'continue_chat');
 assert.match(actions[0].reason,/unreported owner request/);
});
