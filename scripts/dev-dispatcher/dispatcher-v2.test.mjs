import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueue, dispatchFrontier, resolveTaskBase, decideNudge, readyGate } from './core.mjs';
import { createDelivery } from './delivery.mjs';
import { renderOwnerView } from './owner-view.mjs';

const now = Date.parse('2026-11-09T22:00:00Z');
const old = new Date(now-11*60_000).toISOString();
const task = (id, deps=[], edits=[`scripts/${id}.mjs`], uses=[]) => ({
  id, depends_on:deps, edits, uses, architecture_approval:{approved:true},
  state:'architecture_approved', acceptance:['executable'], title:id,
  goal:'Implement safely', brief:'docs/plans/universal-supervisor-task-briefs.md#task-6'
});
const queue = tasks => ({tasks,merged_code_only:[],capacity:{chatgpt:5,claude:0}});
const active = extras => ({ task_id:'child', approved:true, agent:'chatgpt',
  conversation_ref:'https://chatgpt.com/c/test-123', pr_number:408,
  github_state:'open', head_sha:'a'.repeat(40), base_branch:'main',
  last_commit_at:old, prompt_version:'v2', ci_state:'success',
  codex_state:'pending', draft:true, ...extras});

test('base resolves to main with no dependency, open parent head branch while open, main on parent merge',()=>{
  const parent={status:'draft_open',github_state:'open',pr_number:404,
    branch:'feat/a',head_sha:'b'.repeat(40)};
  assert.equal(resolveTaskBase(task('a'),{}).base_branch,'main');
  assert.deepEqual(resolveTaskBase(task('b',['a']),{a:parent}),
    {base_branch:'feat/a',prerequisite_pr:404,waiting_for_parent:true});
  assert.equal(resolveTaskBase(task('b',['a']),{a:{...parent,status:'merged',
    github_state:'merged',merge_sha:'c'.repeat(40)}}).base_branch,'main');
  const assigned=dispatchFrontier(queue([task('a'),task('b',['a'])]),{a:parent});
  assert.equal(assigned[0].base_branch,'feat/a');
});

test('edits are exclusive; uses can import open sibling edits with no owner question',()=>{
  const a=task('a',[],['lib/shared.mjs']);
  const b=task('b',[],['lib/b.mjs'],['lib/shared.mjs']);
  assert.equal(validateQueue(queue([a,b])).size,2);
  assert.equal(dispatchFrontier(queue([a,b]),{}).length,2);
  assert.throws(()=>validateQueue(queue([a,task('c',[],['lib/shared.mjs'])])),
    /Overlapping exclusive file ownership/);
  assert.throws(()=>validateQueue(queue([a,task('c',[],['lib/c.mjs'],['../bad'])])),
    /Invalid read-only file usage/);
});

test('parent-open child keeps coding and CI: no rebase or Codex wait nudge',()=>{
  const rec=active({base_branch:'feat/parent',parent_open:true,ci_state:'success'});
  assert.equal(decideNudge(rec,now).action,'idle_continue');
  assert.equal(decideNudge({...rec,waiting_only_for_parent:true},now).kind,'hold');
  assert.equal(decideNudge({...rec,ci_state:'failure',waiting_only_for_parent:true,
    ci_failure_job:'unit',ci_failure_url:'https://github.com/example/a/actions/runs/99'},now).action,'ci_failed');
  assert.equal(readyGate({...rec,coder_done:true}).eligible,false);
});

test('parent merge results in exactly one rebase prompt keyed by merge SHA, not by child head',()=>{
  const sha='f'.repeat(40);
  const rec=active({parent_merged_sha:sha,base_branch:'feat/parent'});
  const first=decideNudge(rec,now);
  assert.equal(first.action,'parent_merged');
  assert.match(first.key,/parent_merged/);
  assert.equal(decideNudge({...rec,last_parent_rebase_sha:sha},now).kind,'hold');
  assert.equal(decideNudge({...rec,head_sha:'e'.repeat(40)},now).key,first.key);
});

test('each reason produces a single short explicit prompt with its actual evidence',()=>{
  const t=task('child');
  const samples=[
    ['codex_comments',{codex_state:'findings',unresolved_codex_comments:[
      {body:'Guard the null case',url:'https://github.com/example/a/pull/408#discussion_r1'}]},/Guard the null case/],
    ['ci_failed',{ci_state:'failure',ci_failure_job:'unit checks',
      ci_failure_url:'https://github.com/example/a/actions/runs/99'},/unit checks/],
    ['parent_merged',{parent_merged_sha:'f'.repeat(40),base_branch:'feat/parent'},/rebase onto main and continue/i],
    ['owner_answered',{owner_answer_text:'Use existing path only'},/Use existing path only/],
    ['idle_continue',{},/Continue/],
  ];
  for(const [action,extra,expected] of samples){
    const d=createDelivery({task:t,record:active(extra),action,actionId:'v2:'+action});
    assert.match(d.prompt,expected);
    assert.ok(d.prompt.trim().split(/\s+/).length<120,action);
    assert.equal(d.intent,'continue_existing_chat');
    assert.equal(d.prompt_hash.length,64);
  }
  assert.equal(decideNudge(active({codex_state:'findings'}),now).action,'codex_comments');
  assert.equal(decideNudge(active({ci_state:'failure',codex_state:'findings'}),now).action,'ci_failed');
  assert.equal(decideNudge(active({owner_answer_text:'Yes'}),now).action,'owner_answered');
});

test('ready is possible after green CI and coder-done, not before; merge Codex gate remains independent',()=>{
  const base=active({draft:true,coder_done:true,ci_state:'success',base_current:true,
    acceptance_proven:true,threads_resolved:true});
  assert.equal(readyGate(base).eligible,true);
  assert.equal(readyGate({...base,coder_done:false}).eligible,false);
  assert.equal(readyGate({...base,ci_state:'failure'}).eligible,false);
  assert.equal(readyGate({...base,base_branch:'feat/parent'}).eligible,false);
});

test('owner view calls stale cancellations superseded and planned overdue actions courier unconfirmed',()=>{
  const state={version:1,updated_at:old,
    tasks:{child:{pr_number:408,github_state:'open',draft:true}},
    actions:{
      cancelled:{task_id:'child',status:'cancelled_stale_head',type:'idle_continue',created_at:old},
      overdue:{task_id:'child',status:'planned',type:'idle_continue',
        delivery_owner:'muse',created_at:new Date(now-21*60_000).toISOString()}
    }};
  const view=renderOwnerView(state,{repo:'example/a',asOf:new Date(now).toISOString()});
  assert.match(view,/superseded/);
  assert.match(view,/courier unconfirmed/);
  assert.doesNotMatch(view,/cancelled_stale_head/);
});
