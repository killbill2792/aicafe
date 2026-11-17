import test from 'node:test';
import assert from 'node:assert/strict';
import {museActions,normalizeGithubFacts,fetchGithubFacts,reserveMuseActions,runMuseLite} from './muse-lite.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const now='2026-11-16T20:00:00Z',sha='a'.repeat(40);
const c=(head=sha,hasFindings=false)=>({body:
 '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+JSON.stringify({code_review:{commit_sha:head,
  has_any_findings:hasFindings,has_unresolved_findings:hasFindings,status:'completed'}})+' -->',
 author:{login:'chatgpt-codex-connector[bot]'}});
const github=(state='SUCCESS',comments=[c()])=>({data:{repository:{
 pullRequests:{pageInfo:{hasNextPage:false},nodes:[{
  number:488,title:'Proactive investigations',url:'https://github.com/killbill2792/aicafe/pull/488',
  isDraft:false,headRefOid:sha,
  headRef:{target:{committedDate:'2026-11-16T19:40:00Z',
   statusCheckRollup:{state}}},
  comments:{nodes:comments}
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
   'remind_owner');
});
test('missing chat URL blocks sending and GitHub outage keeps local owner reminder',()=>{
 const facts=normalizeGithubFacts(github(),now);
 const missing=museActions(facts,previous,notes('working',''),{now});
 assert.equal(missing.actions.length,0);
 assert.equal(missing.blocked[0].reason,'missing_verified_chat_url');
 const offline=museActions(null,previous,notes('waiting_owner'),{now});
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
