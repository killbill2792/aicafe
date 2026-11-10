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
    approvalMatches: (_task, signed) => signed === 'signed',
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
