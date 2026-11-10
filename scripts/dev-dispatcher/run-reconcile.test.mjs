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
function harness({ assignments = [], proposals = {}, fail = [], receipts = [] } = {}) {
  const errors = [];
  const taskById = new Map(['bad', 'good', 'POS0b', 'POS0c', 'POS0d', 'POS0e']
    .map(id => [id, task(id)]));
  const deps = {
    queue: { tasks: [...taskById.values()] }, taskById,
    receiptScan: { accepted: receipts, rejected: [], complete: true },
    actorMap: {}, console: { error: message => errors.push(message) },
    linkPullRequests: state => ({ state: structuredClone(state), unmapped: [] }),
    reconcileGithub: state => structuredClone(state),
    applyReceiptsSafely: (state, accepted) => {
      const copy = structuredClone(state);
      for (const id of accepted) copy.actions[id].status = 'submitted';
      return { state: copy, rejected: [] };
    },
    reconcileReceiptFeedback: state => state,
    queueOwnerAlerts: state => state,
    revalidateQueuedActions: () => {},
    wakePendingActions: () => {},
    wakeReceiptFeedback: () => {},
    dispatchFrontier: () => assignments,
    assignmentActionKey: (_state, id) => 'assign:' + id,
    approvalSignature: () => 'signed',
    editableFiles: t => t?.exclusive_files || [],
    decideNudge: rec => proposals[rec.task_id] || { kind: 'hold' },
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

test('supersede ONLY planned legacy POS0b/c/d repair and continuation actions', () => {
  const actions = {
    b: { task_id: 'POS0b', type: 'repair_ci', status: 'planned' },
    c: { task_id: 'POS0c', type: 'repair_review', status: 'planned' },
    d: { task_id: 'POS0d', type: 'continue_pr', status: 'planned' },
    submitted: { task_id: 'POS0b', type: 'repair_ci', status: 'submitted' },
    claimed: { task_id: 'POS0c', type: 'repair_ci', status: 'claimed' },
    uncertain: { task_id: 'POS0d', type: 'repair_ci', status: 'uncertain' },
    e: { task_id: 'POS0e', type: 'continue_pr', status: 'planned' },
    decision: { task_id: 'POS0e', type: 'owner_decision', status: 'planned' },
    unrelated: { task_id: 'POS0b', type: 'owner_alert', status: 'submitted' }
  };
  const h = harness({
    proposals: Object.fromEntries(['POS0b', 'POS0c', 'POS0d'].map(id => [
      id, { kind: 'propose', action: 'idle_continue', key: 'idle_continue:' + id + ':head' }
    ]))
  });
  const result = h.run(initial({
    POS0b: record('POS0b'), POS0c: record('POS0c'),
    POS0d: record('POS0d'), POS0e: record('POS0e')
  }, actions));
  for (const key of ['b', 'c', 'd'])
    assert.equal(result.state.actions[key].status, 'cancelled_superseded_template');
  for (const key of ['submitted', 'claimed', 'uncertain', 'e', 'decision', 'unrelated'])
    assert.equal(result.state.actions[key].status, actions[key].status);
  assert.equal(result.state.actions['idle_continue:POS0b:head'].status, 'planned');
  assert.equal(result.state.actions['idle_continue:POS0c:head'], undefined,
    'claimed action still blocks duplicate sends');
  assert.equal(result.state.actions['idle_continue:POS0d:head'], undefined,
    'uncertain action still blocks duplicate sends');
  assert.equal(result.state.owner_alerts.notice.status, 'planned');
});

test('new v2 follow-up replaces a cancelled legacy child action only once', () => {
  const h = harness({ proposals: {
    POS0d: { kind: 'propose', action: 'ci_failed', key: 'ci_failed:POS0d:head' }
  } });
  const first = h.run(initial({ POS0d: record('POS0d') }, {
    old: { task_id: 'POS0d', status: 'planned', type: 'continue_pr' }
  }));
  assert.equal(first.state.actions.old.status, 'cancelled_superseded_template');
  assert.equal(first.state.actions['ci_failed:POS0d:head'].status, 'planned');
  const second = h.run(first.state);
  assert.equal(Object.values(second.state.actions).filter(a =>
    a.task_id === 'POS0d' && a.status === 'planned').length, 1);
});

test('parent-merged receipt, not planning, records the completed merge notification', () => {
  const key = 'parent_merged:POS0b:' + sha;
  const action = { task_id: 'POS0b', type: 'parent_merged', status: 'planned',
    delivery: { action_id: key } };
  const state = initial({
    POS0b: { ...record('POS0b'), parent_merged_sha: sha,
      last_parent_rebase_sha: sha }
  }, { [key]: action });
  const pending = harness().run(state);
  assert.equal(pending.state.tasks.POS0b.last_parent_rebase_sha, null,
    'repair the premature marker written by old dispatcher ticks');
  const submitted = harness({ receipts: [key] }).run(pending.state);
  assert.equal(submitted.state.actions[key].status, 'submitted');
  assert.equal(submitted.state.tasks.POS0b.last_parent_rebase_sha, sha);
});

test('main maintenance excludes unfinished drafts without disabling parent maintenance', () => {
  assert.match(source, /rec\.base_current === false && rec\.base_branch === 'main' &&\s*!\(rec\.draft === true && rec\.coder_done !== true\)/);
  assert.match(source, /await updateChildAfterParentMerge\(\{github:gh,dependent:rec,predecessor:parent\}\)/);
});
