import {settings} from './settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Evaluate the actual nested reconcile function without starting its GitHub
// runner or changing the private ledger. Every dependency is explicitly faked.
const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  function reconcile(state, observed) {');
const end = source.indexOf('\n  const actorMap = ', start);
assert.ok(start >= 0 && end > start, 'reconcile function remains locatable');
const reconcileSource = source.slice(start, end);

const sha = 'f'.repeat(40);
const task = id => ({
  id, exclusive_files: ['scripts/' + id + '.mjs'], architecture_approval: { approved: true },
  state: 'architecture_approved'
});
const record = id => ({
  task_id: id, approved: true, agent: 'chatgpt', approval_hash: 'signed',
  github_state: 'open', pr_number: 400, conversation_ref: 'https://chatgpt.com/c/test-123'
});
const initial = (tasks = {}, actions = {}) => ({
  version: 1, tasks, actions, owner_alerts: { notice: { status: 'planned' } }
});
function harness({ assignments = [], proposals = {}, fail = [], receipts = [], frontier = null, startApproval = state => state } = {}) {
  const errors = [];
  const taskById = new Map(['bad', 'good', 'POS0b', 'POS0c', 'POS0d', 'POS0e', '6']
    .map(id => [id, task(id)]));
  const sourceQueue={tasks:[...taskById.values()]};
  const deps = {
    queue: sourceQueue, taskById, settings,
    receiptScan: { accepted: receipts, rejected: [], complete: true },
    actorMap: {}, console: { error: message => errors.push(message), log: () => {} },
    linkPullRequests: state => ({ state: structuredClone(state), unmapped: [] }),
    adoptAdhocPullRequests: state => ({state:structuredClone(state),skipped:[]}),
    reconcileGithub: state => structuredClone(state),
    applyReceiptsSafely: (state, accepted) => {
      const copy = structuredClone(state);
      for (const id of accepted) copy.actions[id].status = 'submitted';
      return { state: copy, rejected: [] };
    },
    reconcileReceiptFeedback: state => state,
    resolveOwnerIssueIdentity: state => state,
    queueOwnerIssue: (state,incident) => ({owner_alerts:{
      ...state.owner_alerts,
      ['notice:'+incident.kind+':'+incident.identity]:{...incident,status:'planned',recipient:'owner'}
    }}),
    queueOwnerAlerts: state => state,
    noticeOperationalIssues: state => state,
    applySafetySignals: state => state,
    stallMinutes: () => 20,
    repo: 'killbill2792/aicafe',
    process: {env:{}},
    applyOwnerStartApprovals: startApproval,
    advanceApprovedProposals: state => state,
    selectScopePlans: () => ({}),
    queueScopePlanRecovery: state => state,
    queueScopePlanReviews: state => state,
    acceptScopePlanDecisions: state => state,
    effectiveSignedQueue: queue => queue,
    sourceQueue,
    scopeComments:[],
    scopeFetchError:null,
    revalidateQueuedActions: () => {},
    wakePendingActions: () => {},
    wakePendingOwnerNotices: () => {},
    wakeReceiptFeedback: () => {},
    dispatchFrontier: (_queue, records) => frontier ? frontier(records) : assignments,
    assignmentActionKey: (_state, id) => 'assign:' + id,
    approvalSignature: () => 'signed',
    approvalMatches: (_task, signed) => signed === 'signed',
    editableFiles: t => t?.exclusive_files || [],
    decideNudge: rec => proposals[rec.task_id] || { kind: 'hold' },
    createAdhocDelivery: ({ record: rec, action, actionId }) => {
      if (fail.includes(rec.task_id)) throw new Error('synthetic delivery failure');
      return {action_id:actionId,action,task_id:rec.task_id};
    },
    createDelivery: ({ record: rec, action, actionId }) => {
      if (fail.includes(rec.task_id)) throw new Error('synthetic delivery failure');
      return { action_id: actionId, action, task_id: rec.task_id };
    },
  };
  const reconcile = runInNewContext(reconcileSource + '\nreconcile;', deps);
  return {
    run: state => reconcile(state, { snapshot: [], closedByPr: {} }),
    errors
  };
}

test('one failing assignment does not prevent another and never writes a failed task', () => {
  const h = harness({
    assignments: [{ task_id: 'bad', agent: 'chatgpt', base_branch: 'main' },
      { task_id: 'good', agent: 'chatgpt', base_branch: 'main' }],
    fail: ['bad']
  });
  const result = h.run(initial());
  assert.deepEqual(Array.from(result.assigned, a => a.task_id), ['good']);
  assert.equal(result.state.tasks.bad, undefined);
  assert.equal(result.state.actions['assign:bad'], undefined);
  assert.equal(result.state.actions['assign:good'].status, 'planned');
  assert.equal(result.state.owner_alerts['notice:assignment_build_failed:assign:bad'].status,'planned');
  assert.match(h.errors.join('\n'), /Task bad delivery creation failed: synthetic delivery failure/);
});

test('one failing follow-up does not block other tasks or write action or early parent marker', () => {
  const h = harness({
    proposals: {
      bad: { kind: 'propose', action: 'parent_merged', key: 'parent_merged:bad:' + sha },
      good: { kind: 'propose', action: 'idle_continue', key: 'idle_continue:good:new' }
    },
    fail: ['bad']
  });
  const state = initial({
    bad: { ...record('bad'), parent_merged_sha: sha },
    good: record('good')
  });
  const result = h.run(state);
  assert.equal(result.state.actions['parent_merged:bad:' + sha], undefined);
  assert.equal(result.state.tasks.bad.last_action_key, undefined);
  assert.equal(result.state.tasks.bad.last_parent_rebase_sha, undefined);
  assert.equal(result.state.actions['idle_continue:good:new'].status, 'planned');
  assert.equal(result.state.tasks.good.last_action_key, 'idle_continue:good:new');
  assert.equal(result.state.owner_alerts['notice:courier_prompt_build_failed:parent_merged:bad:'+sha].status,'planned');
  assert.deepEqual(Array.from(result.nudges, x => x.task_id), ['good']);
  assert.match(h.errors.join('\n'), /Task bad delivery creation failed: synthetic delivery failure/);
});

test('main maintenance excludes unfinished drafts without disabling parent maintenance', () => {
  assert.match(source, /rec\.base_current === false && rec\.base_branch === 'main' &&\s*!\(rec\.draft === true && rec\.ci_state !== 'success'\)/);
  assert.match(source, /await updateChildAfterParentMerge\(\{github:gh,dependent:rec,predecessor:parent,/);
});

test('one live pending checklist per PR even if two task records reference it',()=>{
  const h=harness({proposals:{
    bad:{kind:'propose',action:'idle_continue',key:'idle_continue:bad:head'},
    good:{kind:'propose',action:'idle_continue',key:'idle_continue:good:head'}
  }});
  const result=h.run(initial({bad:record('bad'),good:record('good')}));
  const planned=Object.values(result.state.actions).filter(a=>a.status==='planned');
  assert.equal(planned.length,1);
  assert.equal(planned[0].task_id,'bad');
});

test('merged landing failure reuses existing Muse action and keeps it planned across ticks',()=>{
  const h=harness();
  const sha='e'.repeat(40);
  const task={...record('good'),github_state:'merged',status:'merged',merge_sha:sha,
    landing_failure:'<!-- landing-check-failure sha:'+sha+' -->\\nError tail'};
  const first=h.run(initial({good:task}));
  const id='landing_failed:good:'+sha;
  assert.equal(first.state.actions[id].type,'landing_failed');
  assert.equal(first.state.actions[id].delivery_owner,'muse');
  assert.equal(first.state.actions[id].status,'planned');
  const again=h.run(first.state);
  assert.equal(again.state.actions[id].status,'planned');
  assert.equal(Object.values(again.state.actions).filter(x=>x.type==='landing_failed').length,1);
});


test('current-head Codex finding keeps its planned coder prompt until a real push or receipt',()=>{
  const current='f'.repeat(40);
  const actionKey='work:POS0f:'+current+':codex_comments:review-1';
  const prior=initial({POS0f:{...record('POS0f'),pr_number:422,
    codex_state:'findings',head_sha:current,submission_state:'idle'}},{
    [actionKey]:{task_id:'POS0f',type:'codex_comments',
      head_sha:current,status:'planned',
      delivery:{action_id:actionKey,conversation_url:'https://chatgpt.com/c/test-123'}}
  });
  const run=harness({proposals:{POS0f:{kind:'hold',reason:'already_delivered_for_state'}}}).run;
  const next=run(prior).state;
  assert.equal(next.actions[actionKey].status,'planned');
  assert.equal(Object.values(next.actions).filter(a=>a.status==='planned').length,1);
});
test('merged PR chat index is retained and newest courier URL repairs stale task link',()=>{
  const newUrl='https://chatgpt.com/c/verified-new';
  const state=initial({POS0d:{...record('POS0d'),pr_number:407,
    github_state:'merged',last_submission_at:'2026-11-10T11:00:00Z'}});
  state.pr_chat_links={407:{task_id:'POS0d',conversation_url:newUrl,
    updated_at:'2026-11-10T19:00:00Z',head_sha:'f'.repeat(40)}};
  const out=harness().run(state).state;
  assert.equal(out.tasks.POS0d.conversation_ref,newUrl);
  assert.equal(out.tasks.POS0d.conversation_url,newUrl);
  assert.equal(out.pr_chat_links[407].conversation_url,newUrl);
});


test('failed replacement Codex delivery cannot cancel current planned findings prompt',()=>{
 const prev='old:review-1',next='work:bad:new-review';
 const h=harness({proposals:{bad:{kind:'propose',action:'codex_comments',key:next}},fail:['bad']});
 const rec={...record('bad'),head_sha:'f'.repeat(40),codex_state:'findings',
  submission_state:'idle'};
 const state=initial({bad:rec},{[prev]:{task_id:'bad',type:'codex_comments',
  status:'planned',head_sha:rec.head_sha,delivery:{action_id:prev}}});
 const out=h.run(state).state;
 assert.equal(out.actions[prev].status,'planned');
 assert.equal(out.actions[next],undefined);
 assert.match(h.errors.join('\n'),/delivery creation failed/);
});
test('successful replacement Codex delivery supersedes old planned prompt atomically',()=>{
 const prev='old:review-1',next='work:bad:new-review';
 const h=harness({proposals:{bad:{kind:'propose',action:'codex_comments',key:next}}});
 const rec={...record('bad'),head_sha:'f'.repeat(40),codex_state:'findings',
  submission_state:'idle'};
 const state=initial({bad:rec},{[prev]:{task_id:'bad',type:'codex_comments',
  status:'planned',head_sha:rec.head_sha,delivery:{action_id:prev}}});
 const out=h.run(state).state;
 assert.equal(out.actions[prev].status,'cancelled_state_changed');
 assert.equal(out.actions[next].status,'planned');
 assert.equal(Object.values(out.actions).filter(x=>x.status==='planned').length,1);
});


test('Task 6 held approval never silently assigns after priority clearance',()=>{
 const current={task_id:'6',status:'blocked_needs_owner',agent:'chatgpt',
  approved:false,priority_deferred:true,approval_hash:'old-annotation-signature'};
 const out=harness({frontier:records=>records['6']?.approved?
  [{task_id:'6',agent:'chatgpt',base_branch:'main'}]:[]}).run(initial({'6':current}));
 assert.equal(out.state.actions['assign:6'],undefined);
 assert.equal(out.state.tasks['6'].approved,false);
});
test('hash-bound Muse yes resumes the same-tick frontier with one assignment',async()=>{
 const {applyOwnerStartApprovals,noticeHash}=await import('./alerts.mjs');
 const {approvalSignature}=await import('./delivery.mjs');
 const plan=task('6'),hash=approvalSignature(plan),key='notice:'+noticeHash({kind:'next_task_start',task_id:'6',source_sha:hash});
 const tasks={'6':{task_id:'6',approved:false,status:'blocked_needs_owner',priority_deferred:true,
  owner_reply_events:{yes:{courier:'muse',text:'yes',target:{notice_id:key}}}}};
 const s=initial(tasks);s.owner_alerts={[key]:{kind:'next_task_start',status:'submitted',source_sha:hash}};
 const h=harness({startApproval:applyOwnerStartApprovals,
  frontier:records=>records['6']?.approved&&records['6'].status==='proposed'
   ?[{task_id:'6',agent:'chatgpt',base_branch:'main'}]:[]});
 const out=h.run(s).state;assert.equal(out.tasks['6'].status,'assigned');
 assert.equal(out.actions['assign:6'].status,'planned');
 assert.equal(out.actions['assign:6'].delivery_owner,'muse');
});

test('a cached merged PR never downgrades or cancels its existing landing repair',async()=>{
 const {reconcileGithub}=await import('./core.mjs');
 const merged='a'.repeat(40),at='2026-11-11T11:30:00Z';
 const id='landing_failed:T:'+merged;
 const state={tasks:{T:{task_id:'T',pr_number:407,github_state:'merged',
    status:'merged',merge_sha:merged,merged_at:at,landing_failure:'bot landing failure'}},
   actions:{[id]:{task_id:'T',type:'landing_failed',status:'planned',head_sha:merged}}};
 const noRefetch=reconcileGithub(state,[],{});
 assert.equal(noRefetch.tasks.T.github_state,'merged');
 assert.equal(noRefetch.tasks.T.merge_sha,merged);
 assert.equal(noRefetch.actions[id].status,'planned');
 const last='2026-11-11T12:00:00Z';
 const fromGitHub=reconcileGithub(state,[],{407:{merged:true,merge_sha:merged,
   merged_at:at,last_landing_check_at:last,landing_failure:'bot landing failure'}});
 assert.equal(fromGitHub.tasks.T.github_state,'merged');
 assert.equal(fromGitHub.tasks.T.merged_at,at);
 assert.equal(fromGitHub.tasks.T.last_landing_check_at,last);
 assert.equal(fromGitHub.actions[id].status,'planned');
});

test('actual reconciler preserves unsigned scope handoff and signed coding continuation',()=>{
 const {run}=harness();
 const state=initial({'7':{task_id:'7',agent:'chatgpt',approved:false,
   planning_approved:true,status:'scope_planning',
   approval_hash:'a'.repeat(64)}},{
   'scope_plan:7:notice':{type:'scope_plan',task_id:'7',status:'planned',delivery_owner:'muse'}
 });
 const next=run(state).state;
 assert.equal(next.actions['scope_plan:7:notice'].status,'planned');
 const coding=initial({'7':{task_id:'7',agent:'chatgpt',approved:true,status:'assigned',
   approval_hash:'b'.repeat(64)}},{
   'assign:7':{type:'begin_scoped_coding',task_id:'7',status:'planned',delivery_owner:'muse'}
 });
 assert.equal(run(coding).state.actions['assign:7'].status,'planned');
});


test('delayed self-wake retains Git-backed emergency notice after a failed wake',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/dispatcher-delayed-wake.yml',import.meta.url),'utf8');
 assert.match(workflow,/if: failure\(\)/);
 assert.match(workflow,/node scripts\/dev-dispatcher\/emergency-report\.mjs/);
 assert.match(workflow,/secrets\.DISPATCH_LEDGER_TOKEN/);
});


test('failed dispatcher run observer uses trusted main and existing Git-backed owner queue only',()=>{
 const watcher=readFileSync(new URL('../../.github/workflows/dispatcher-failure-observer.yml',import.meta.url),'utf8');
 assert.match(watcher,/workflow_run:/);
 assert.match(watcher,/AI CAFE Development Dispatcher/);
 assert.match(watcher,/Dispatcher delayed self-wake/);
 assert.match(watcher,/head_branch == 'main'/);
 assert.match(watcher,/ref: main/);
 assert.match(watcher,/persist-credentials: false/);
 assert.match(watcher,/DISPATCH_FAILED_RUN_ID:/);
 assert.match(watcher,/node scripts\/dev-dispatcher\/emergency-report\.mjs/);
 assert.doesNotMatch(watcher,/pull_request_target/);
});


test('new emergency observer remains owner-only infrastructure, while PR size guard stays intact',async()=>{
 const {isDispatcherMaintenanceChange,dispatcherOnlyFiles}=await import('./github.mjs');
 const {hasBigOk}=await import('../guards/pr-size.mjs');
 const paths=[{filename:'.github/workflows/dispatcher-failure-observer.yml'},
  {filename:'scripts/dev-dispatcher/heartbeat-probe.mjs'}];
 assert.equal(isDispatcherMaintenanceChange(paths),true);
 assert.equal(dispatcherOnlyFiles(paths),true);
 assert.equal(hasBigOk(''),false);
 assert.equal(hasBigOk('big-ok'),true);
 assert.equal(hasBigOk(JSON.stringify([{name:'big-ok'}])),true);
});
