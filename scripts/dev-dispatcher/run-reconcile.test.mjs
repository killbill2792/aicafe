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
function harness({ assignments = [], proposals = {}, fail = [], receipts = [], frontier = null } = {}) {
  const errors = [];
  const taskById = new Map(['bad', 'good', 'POS0b', 'POS0c', 'POS0d', 'POS0e', '6']
    .map(id => [id, task(id)]));
  const deps = {
    queue: { tasks: [...taskById.values()] }, taskById,
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
    queueOwnerAlerts: state => state,
    applyOwnerStartApprovals: state => state,
    revalidateQueuedActions: () => {},
    wakePendingActions: () => {},
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
  assert.deepEqual(Array.from(result.nudges, x => x.task_id), ['good']);
  assert.match(h.errors.join('\n'), /Task bad delivery creation failed: synthetic delivery failure/);
});

test('main maintenance excludes unfinished drafts without disabling parent maintenance', () => {
  assert.match(source, /rec\.base_current === false && rec\.base_branch === 'main' &&\s*!\(rec\.draft === true && rec\.ci_state !== 'success'\)/);
  assert.match(source, /await updateChildAfterParentMerge\(\{github:gh,dependent:rec,predecessor:parent\}\)/);
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
