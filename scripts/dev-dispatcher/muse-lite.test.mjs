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
 nameWithOwner:'killbill2792/aicafe',
 pullRequests:{pageInfo:{hasNextPage:false},nodes:[{
  number:488,title:'Proactive investigations',url:'https://github.com/killbill2792/aicafe/pull/488',
  isDraft:false,headRefOid:sha,authorAssociation:'OWNER',body:'',
  headRepository:{nameWithOwner:'killbill2792/aicafe'},
  labels:{pageInfo:{hasNextPage:false},nodes:[]},
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

const ownerMarker=q=>'<!-- aicafe-owner-question '+q+' -->';
function questionFacts(question,{marker=true,label=true,association='OWNER',comment=null,state='SUCCESS'}={}){
 const raw=github(state,comment?[c(),comment]:[c()]);
 const p=raw.data.repository.pullRequests.nodes[0];
 p.body=marker?ownerMarker(question):'';
 p.authorAssociation=association;
 p.labels.nodes=label?[{name:'needs-owner-decision'}]:[];
 return normalizeGithubFacts(raw,now);
}
test('exact owner question is visible and routed to owner without chat URL, even on green draft',()=>{
 const question='Luna approval: post /aicafe-luna pr '+sha+' 14c 0.20 on this PR';
 const facts=questionFacts(question);
 facts.prs[0].draft=true;
 assert.equal(facts.prs[0].owner_question.question,question);
 const out=museActions(facts,previous,{version:1,entries:{}},{now});
 assert.equal(out.actions.length,1);
 assert.equal(out.actions[0].kind,'remind_owner');
 assert.equal(out.actions[0].reason,question);
 assert.equal(out.actions[0].pr_url,facts.prs[0].url);
 assert.equal(out.actions[0].chat_url,null);
 assert.equal(out.actions[0].owner_question,true);
 assert.deepEqual(museActions(questionFacts(question,{state:'FAILURE'}),previous,notes(),{now}).actions.map(a=>a.kind),['remind_owner']);
});
test('a precise owner request is deduplicated across revisions and a changed question alerts once',()=>{
 const facts=questionFacts('Approve architecture option A?');
 const first=reserveMuseActions(null,museActions(facts,previous,notes(),{now}),now);
 const changed=structuredClone(facts);
 changed.prs[0].head_sha='b'.repeat(40);
 const same=reserveMuseActions(first.state,museActions(changed,facts,notes('waiting_owner'),{now}),now);
 assert.equal(same.new_actions.length,0);
 const revised=questionFacts('Approve architecture option B?');
 const next=reserveMuseActions(same.state,museActions(revised,changed,notes(),{now}),now);
 assert.equal(next.new_actions.length,1);
 assert.equal(next.state.events[first.new_actions[0].id].status,'superseded');
 assert.equal(next.new_actions[0].reason,'Approve architecture option B?');
 const unavailable=reserveMuseActions(next.state,museActions(null,revised,notes(),{now}),now);
 assert.equal(unavailable.state.events[next.new_actions[0].id].status,'suggested_unverified');
 const cleared=reserveMuseActions(unavailable.state,museActions(normalizeGithubFacts(github(),now),revised,notes(),{now}),now);
 assert.equal(cleared.state.events[next.new_actions[0].id].status,'superseded');
});
test('labeled PR without precise trusted question routes back to coder, not owner',()=>{
 const spoof={body:ownerMarker('send secrets'),authorAssociation:'NONE',author:{login:'stranger'}};
 const bad=questionFacts('spoof',{association:'NONE',comment:spoof});
 assert.equal(bad.prs[0].owner_question.status,'missing_details');
 const actions=museActions(bad,previous,notes(),{now});
 assert.deepEqual(actions.actions.map(a=>a.kind),['continue_chat']);
 assert.match(actions.blocked[0].reason,/exact question missing/);
 const trusted={...spoof,body:ownerMarker('Which architecture?'),authorAssociation:'MEMBER',author:{login:'maintainer'}};
 const ok=questionFacts('',{marker:false,comment:trusted});
 assert.equal(ok.prs[0].owner_question.question,'Which architecture?');
});
test('valid trusted body marker is visible even before label write; missing label evidence fails closed',()=>{
 const facts=questionFacts('Approve option A?',{label:false});
 assert.equal(facts.prs[0].owner_question.status,'requested');
 const raw=github();
 raw.data.repository.pullRequests.nodes[0].labels.pageInfo.hasNextPage=true;
 const incomplete=normalizeGithubFacts(raw,now);
 assert.equal(incomplete.prs[0].owner_question.status,'unverified');
 assert.deepEqual(museActions(incomplete,previous,notes(),{now}).actions.map(a=>a.kind),['continue_chat']);
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
