import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLifecycleDashboard} from './lifecycle-dashboard-v3.mjs';
import {recordLifecycleTransitions} from './lifecycle-v3.mjs';
const head='a'.repeat(40),base='b'.repeat(40),now='2026-11-11T10:00:00Z';
const queue={repo:'killbill2792/aicafe',tasks:[{id:'CR-A',title:'Coffee receipts',
  state:'ready',architecture_approval:{approved:true},depends_on:[],
  acceptance:['test'],edits:['lib/coffee.ts']}]};
const state={version:1,updated_at:now,tasks:{'CR-A':{task_id:'CR-A',
 approved:true,github_state:'open',pr_number:445,head_sha:head,base_sha:base,
 base_current:true,draft:false,ci_state:'success',codex_state:'clean',
 codex_reviewed_sha:head,threads_resolved:true,mergeable:true,
 last_commit_at:'2026-11-11T09:50:00Z',branch:'feat/aicafe-task-CR-A'}},
 actions:{},owner_alerts:{}};
test('private ledger shows requested lifecycle columns and exact next actor',()=>{
 const projected=recordLifecycleTransitions(state,queue,now);
 const text=renderLifecycleDashboard(projected,{now});
 assert.match(text,/Codex trigger/);
 assert.match(text,/Last commit/);
 assert.match(text,/Merge eligible/);
 assert.match(text,/GitHub pull request/);
 assert.match(text,/Acceptance evidence/);
 assert.match(text,/MERGE_IF_AUTHORIZED/);
 assert.match(text,/CR-A/);
});
test('private projection stays byte identical for unchanged remote state',()=>{
 const projected=recordLifecycleTransitions(state,queue,now);
 const early=renderLifecycleDashboard(projected,{now:'2026-11-11T10:01:00Z'});
 const later=renderLifecycleDashboard(projected,{now:'2026-11-11T10:01:00Z'});
 assert.equal(early,later);
});
test('renderer refuses another ledger schema and rejects malicious repo',()=>{
 assert.throws(()=>renderLifecycleDashboard({version:2}),/Private ledger/);
 assert.throws(()=>renderLifecycleDashboard(state,{repo:'evil/repo?x'}),/Invalid repository/);
});
