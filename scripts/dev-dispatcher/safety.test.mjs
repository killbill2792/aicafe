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
