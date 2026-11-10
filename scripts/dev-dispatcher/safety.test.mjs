import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applySafetySignals,expectedTaskRepo,stallMinutes,STALL_PROMPT} from './safety.mjs';
const head='a'.repeat(40);
const base={tasks:{T:{task_id:'T',repo:'owner/aicafe',approved:true,conversation_ref:'https://chatgpt.com/c/real',
  github_state:'open',pr_number:12,head_sha:head,last_commit_at:'2026-11-10T10:00:00Z',
  last_submission_at:'2026-11-10T10:05:00Z'}},actions:{}};
const run=(s,now='2026-11-10T10:26:00Z')=>applySafetySignals(s,{repo:'owner/aicafe',now,queue:[],minutes:20});
test('queue/ledger repository fact wins over a PR body',()=>{
 assert.equal(expectedTaskRepo({repo:'other/product'},{repo:'owner/aicafe'},'owner/aicafe'),'other/product');
 let s=applySafetySignals(base,{repo:'other/product',queue:[{id:'T',repo:'owner/aicafe'}],now:'2026-11-10T10:26:00Z'});
 assert.deepEqual(s.tasks.T.repo_mismatch,{expected:'owner/aicafe',actual:'other/product',pr_number:12});
 assert.equal(s.tasks.T.stall_pending,null);
});
test('20 minute default, override and no premature prompt',()=>{
 assert.equal(stallMinutes(),20);assert.equal(stallMinutes('7'),7);assert.equal(stallMinutes('oops'),20);
 assert.equal(run(base,'2026-11-10T10:24:00Z').tasks.T.stall_count,0);
 assert.match(STALL_PROMPT,/Resource not accessible by integration/);
});
test('three authenticated same-head stalls escalate once and stop nudges',()=>{
 let s=run(base);assert.equal(s.tasks.T.stall_count,1);assert.match(s.tasks.T.stall_pending,/stall:/);
 s=run(s);assert.equal(s.tasks.T.stall_count,1);
 s.tasks.T.last_submission_at='2026-11-10T10:27:00Z';s=run(s,'2026-11-10T10:48:00Z');
 assert.equal(s.tasks.T.stall_count,2);
 s.tasks.T.last_submission_at='2026-11-10T10:49:00Z';s=run(s,'2026-11-10T11:10:00Z');
 assert.equal(s.tasks.T.stall_count,3);assert.equal(s.tasks.T.stall_escalate,true);assert.equal(s.tasks.T.stall_pending,null);
 assert.equal(run(s,'2026-11-10T11:30:00Z').tasks.T.stall_count,3);
});
test('head movement and verified done suppress or reset stalls',()=>{
 let s=run(base);s.tasks.T.head_sha='b'.repeat(40);
 assert.equal(run(s).tasks.T.stall_count,0);
 s=structuredClone(base);s.tasks.T.coder_done=true;assert.equal(run(s).tasks.T.stall_pending,null);
 s=structuredClone(base);s.tasks.T.last_commit_at='2026-11-10T10:06:00Z';
 assert.equal(run(s).tasks.T.stall_pending,null);
});

test('landing failures come only from the Actions bot for the exact merge SHA',async()=>{
 const {landingFailureForMerge}=await import('./safety.mjs');
 const merge='f'.repeat(40), other='e'.repeat(40);
 const forged={user:{login:'attacker'},body:'<!-- landing-check-failure sha:'+merge+' -->\nerror'};
 const valid={user:{login:'github-actions[bot]'},body:'<!-- landing-check-failure sha:'+merge+' -->\nreal error tail'};
 assert.equal(landingFailureForMerge([forged,valid],merge),valid.body);
 assert.equal(landingFailureForMerge([valid],other),null);
});
test('reported 403 requires the actual PR author or owner',async()=>{
 const {reportedConnector403}=await import('./safety.mjs');
 const msg="GitHub 403 'Resource not accessible by integration'";
 assert.equal(reportedConnector403([{user:{login:'stranger'},body:msg}],'coder'),false);
 assert.equal(reportedConnector403([{user:{login:'coder'},body:msg}],'coder'),true);
 assert.equal(reportedConnector403([{author_association:'OWNER',body:msg}],'coder'),true);
 assert.equal(reportedConnector403([{user:{login:'chatgpt-codex-connector[bot]'},body:msg}],'coder'),true);
});
test('chat-written field failures retain exact annotation and fix text',async()=>{
 const {failureInstruction}=await import('./safety.mjs');
 assert.match(failureInstruction([{message:'Invalid aicafe-chat-url: expected canonical URL'}]),/Fix: use <!-- aicafe-chat-url/);
 assert.match(failureInstruction([{message:'vision version mismatch: expected v12'}]),/vision version mismatch: expected v12\nFix:/);
 assert.equal(failureInstruction([{message:'TypeScript error'}]),null);
});

test('only an actual repo marker mismatch blocks the existing merge decision',async()=>{
 const {mergeGate,readyGate,decideNudge}=await import('./core.mjs');
 const good={draft:false,pr_number:17,head_sha:'a'.repeat(40),ci_state:'success',
   codex_state:'clean',codex_reviewed_sha:'a'.repeat(40),threads_resolved:true,
   mergeable:true,approved:true,conversation_ref:'https://chatgpt.com/c/test',
   github_state:'open',task_id:'T'};
 assert.equal(mergeGate(good).eligible,true);
 assert.equal(mergeGate({...good,repo_marker_mismatch:true}).reasons.includes('wrong_repository'),true);
 assert.equal(readyGate({...good,draft:true,repo_mismatch:{expected:'x/y',actual:'a/b'}}).eligible,false);
 assert.equal(decideNudge({...good,repo_marker_mismatch:true,repo_marker_failure:'wrong repo'}).action,'ci_failed');
});

test('a newer verified head beats misleading commit author timestamps',()=>{
 const s=structuredClone(base);
 s.tasks.T.last_prompt_head_sha='b'.repeat(40);
 assert.equal(run(s).tasks.T.stall_pending,null);
 s.tasks.T.last_prompt_head_sha=head;
 assert.equal(run(s).tasks.T.stall_count,1);
});

test('existing owner notices flag wrong-repo, connector 403 and third stall',async()=>{
 const {queueOwnerAlerts}=await import('./alerts.mjs');
 const st={tasks:{T:{task_id:'T',pr_number:12,repo:'owner/product',repo_mismatch:{expected:'other/repo',actual:'owner/aicafe'},
  connector_403:true,stall_escalate:true,head_sha:head}},actions:{}};
 const next=queueOwnerAlerts(st,{now:'2026-11-10T11:00:00Z'});
 const notes=Object.values(next.owner_alerts);
 assert.deepEqual(notes.map(n=>n.kind).sort(),['connector_403','repeated_stall','wrong_repo']);
 assert.ok(notes.some(n=>n.question==='ChatGPT Codex Connector likely missing repo other/repo'));
 assert.ok(notes.some(n=>/D7 referee/.test(n.question)));
});

test('nonrequired existing check with exact field annotation still gets same-chat repair',async()=>{
 const {decideNudge}=await import('./core.mjs');
 const rec={approved:true,conversation_ref:'https://chatgpt.com/c/test',pr_number:7,github_state:'open',
 task_id:'T',head_sha:head,ci_state:'success',field_check_failure:true,
 ci_failure_fix:'Invalid vision version\\nFix: update version'};
 const action=decideNudge(rec);
 assert.equal(action.kind,'propose');
 assert.equal(action.action,'ci_failed');
 assert.match(action.key,/Invalid%20vision/);
});
