import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChatMarker, dispatcherOnlyFiles} from './github.mjs';
import {adoptAdhocPullRequests,linkPullRequests} from './dependencies.mjs';
import {decideNudge,mergeGate,reconcileGithub} from './core.mjs';
import {createAdhocDelivery} from './delivery.mjs';
import {mergeApprovedPr} from './effects.mjs';

const sha='a'.repeat(40);
const chat='https://chatgpt.com/g/ai-cafe/c/123e4567-e89b-12d3-a456-426614174000';
const pr=(number,extras={})=>({
  pr_number:number,branch:'fix/example-'+number,base_branch:'main',
  head_sha:sha,base_sha:'b'.repeat(40),same_repo:true,bot_author:false,
  chat_marker:chat,task_marker:null,mergeable:true,mergeable_state:'clean',
  ci_state:'failure',ci_failure_job:'Test',ci_failure_url:'https://github.com/killbill2792/aicafe/actions/runs/123',
  codex_state:'pending',threads_resolved:true,draft:true,
  last_commit_at:'2026-11-10T12:00:00Z',...extras
});
const state=()=>({tasks:{},actions:{}});

test('accepts exactly one valid ChatGPT chat marker and rejects forged destinations',()=>{
  assert.equal(parseChatMarker('<!-- aicafe-chat-url '+chat+' -->'),chat);
  for(const url of [
    'http://chatgpt.com/c/abc','https://chatgpt.com.evil.org/c/abc',
    'https://chatgpt.com/share/abc','https://chatgpt.com/c/abc?source=pr',
    'https://chatgpt.com/c/abc#fragment','https://evil.org/c/abc'
  ]) assert.equal(parseChatMarker('<!-- aicafe-chat-url '+url+' -->'),null);
  assert.equal(parseChatMarker('<!-- aicafe-chat-url '+chat+' --><!-- aicafe-chat-url '+chat+' -->'),null);
});

test('adopts eligible open human same-repo PR and retains destination after reconciliation',()=>{
  const candidate=pr(501);
  const found=adoptAdhocPullRequests(state(),[candidate],['POS0a']);
  assert.equal(found.state.tasks['ADHOC-501'].conversation_ref,chat);
  assert.equal(found.state.tasks['ADHOC-501'].approved,true);
  const linked=linkPullRequests(found.state,[candidate]);
  const updated=reconcileGithub(linked.state,[candidate]);
  assert.equal(updated.tasks['ADHOC-501'].github_state,'open');
  assert.equal(updated.tasks['ADHOC-501'].head_sha,sha);
  assert.equal(updated.tasks['ADHOC-501'].conversation_ref,chat);
});

test('excludes forks, bots, queue tasks and PRs lacking verified chat marker',()=>{
  const cases=[
    pr(502,{same_repo:false}),
    pr(503,{bot_author:true}),
    pr(504,{chat_marker:null}),
    pr(505,{task_marker:'POS0a'}),
    pr(506,{branch:'feat/aicafe-task-POS0b'})
  ];
  const found=adoptAdhocPullRequests(state(),cases,['POS0a','POS0b']);
  assert.deepEqual(Object.keys(found.state.tasks),[]);
  assert.deepEqual(found.skipped,[504]);
});

test('existing queue mapping is never replaced by ad hoc identity',()=>{
  const initial=state();
  initial.tasks.POS0c={task_id:'POS0c',pr_number:507,branch:'feat/aicafe-task-POS0c'};
  const found=adoptAdhocPullRequests(initial,[pr(507)],['POS0c']);
  assert.deepEqual(Object.keys(found.state.tasks),['POS0c']);
});

test('only dispatcher and workflow paths demand owner merge, never automatic merge',async()=>{
  assert.equal(dispatcherOnlyFiles([{filename:'scripts/dev-dispatcher/run.mjs'},{filename:'.github/workflows/ci.yml'}]),true);
  assert.equal(dispatcherOnlyFiles([{filename:'AGENTS.md'}]),false);
  assert.equal(dispatcherOnlyFiles([{filename:'src/app.ts'}]),false);
  let called=false;
  const record={...pr(508,{draft:false,ci_state:'success',codex_state:'clean',codex_reviewed_sha:sha}),
    task_id:'ADHOC-508',adhoc:true,approved:true,github_state:'open',
    dispatcher_only:true};
  assert.equal(mergeGate(record).eligible,true);
  const result=await mergeApprovedPr({github:{request:async()=>{called=true;throw Error('unexpected');}},
    record,action:'merge',enabled:true});
  assert.deepEqual(result,{status:'blocked',reasons:['owner_merge_required']});
  assert.equal(called,false);
});

test('failure routes one action to adopted marker chat, and a new head changes work key',()=>{
  const candidate=pr(509);
  const adopted=adoptAdhocPullRequests(state(),[candidate]).state.tasks['ADHOC-509'];
  const live=reconcileGithub({tasks:{'ADHOC-509':adopted},actions:{}},[candidate]).tasks['ADHOC-509'];
  const proposal=decideNudge(live);
  assert.equal(proposal.action,'ci_failed');
  const delivery=createAdhocDelivery({record:live,action:proposal.action,actionId:proposal.key});
  assert.equal(delivery.conversation_url,chat);
  assert.equal(delivery.intent,'continue_existing_chat');
  assert.equal(delivery.task_id,'ADHOC-509');
  assert.equal(delivery.prompt_hash.length,64);
  const next={...live,head_sha:'c'.repeat(40)};
  assert.notEqual(decideNudge(next).key,proposal.key);
  assert.equal(decideNudge({...live,ci_state:'success',codex_state:'clean',mergeable:true}).kind,'hold');
  assert.throws(()=>createAdhocDelivery({record:{...live,conversation_ref:'https://evil.org/c/abc'},
    action:'ci_failed',actionId:proposal.key}));
});
