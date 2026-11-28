// Run on a freshly migrated, seeded local Supabase database. Each trial owns
// fresh users and cafés and uses independent sessions for conflicting claims.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { verifyResult } from './assignment-result.mjs';
import { verifySteering } from './assignment-inputs.mjs';
import { verifyWorkforceProfiles } from './workforce-profiles.mjs';
import { verifyLegacyFollowups } from './legacy-followups.mjs';

const connectionString = process.env.SUPERVISOR_RUN_DB_URL;
const target = new URL(connectionString);
assert.ok(target.protocol === 'postgresql:' && ['127.0.0.1', 'localhost'].includes(target.hostname)
  && ['54322', '55322'].includes(target.port) && target.pathname === '/postgres', 'local disposable Supabase required');

const admin = new Client({ connectionString });
const workers = [new Client({ connectionString }), new Client({ connectionString })];
const fixtures = [];
async function fixture() {
  const [business, owner, thread, request] = Array.from({ length: 4 }, () => randomUUID());
  fixtures.push({ business, owner });
  await admin.query("insert into auth.users(id,aud,role,email) values ($1,'authenticated','authenticated',$2)",
    [owner, owner + '@example.invalid']);
  await admin.query("insert into public.businesses(id,name,timezone) values ($1,'Disposable Luna café',current_setting('TimeZone'))", [business]);
  await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')", [business, owner]);
  await admin.query('insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)',
    [thread, business, owner, randomUUID()]);
  await admin.query(`insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
    values ($1,$2,$3,$4,$3,'owner','text','Which changes deserve attention today?',$5)`, [request, business, owner, thread, randomUUID()]);
  return { scope: [business, owner, thread], request };
}

async function admit(db, { scope, request }) {
  const result = await db.query(`select public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,'en','{}') as run`,
    [...scope, request, 'a'.repeat(64)]);
  return result.rows[0].run;
}

const claimEntry = { legacy: 'supervisor_run_claim', replacement: 'luna_assignment_claim' };
async function claim(db, engine, scope, run) {
  const result = await db.query('select public.' + claimEntry[engine] + '($1,$2,$3,$4,$5,60) as claim',
    [...scope, run.id, randomUUID()]);
  return result.rows[0].claim;
}

async function verifyFleetDispatch(a, b) {
  const hot = await fixture();
  const cold = await fixture();
  const legacy = await fixture();
  await a.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true),($2,true)',
    [hot.scope[0], cold.scope[0]]);
  const enqueue = async cafe => (await a.query(`select public.supervisor_run_start(
    $1,$2,$3,$4,$5,'[{"key":"read","retry":"idempotent"}]') as run`,
    [...cafe.scope, randomUUID(), 'c'.repeat(64)])).rows[0].run;
  const oldest = await enqueue(hot);
  const backlog = await enqueue(hot);
  const coldRun = await enqueue(cold);
  const legacyRun = await enqueue(legacy);
  const take = async db => (await db.query('select public.luna_claim_next_assignment($1,60) as work',
    [randomUUID()])).rows[0].work;
  const [first, old] = await Promise.all([take(a), b.query('select public.supervisor_select_next_durable_run() as work')]);
  assert.deepEqual(old.rows[0].work, { run_id: legacyRun.id, recovery: false });
  assert.equal(first.run_id, oldest.id);
  assert.equal(first.claim.kind, 'claimed');
  const second = await take(b);
  assert.equal(second.run_id, coldRun.id);
  assert.equal(second.business_id, cold.scope[0]);
  assert.equal(second.claim.kind, 'claimed');
  // Revocation must commit its blocked state and let the poller move on.
  await admin.query('delete from public.memberships where business_id=$1 and user_id=$2', hot.scope.slice(0, 2));
  const revoked = await take(a);
  assert.equal(revoked.run_id, backlog.id);
  assert.deepEqual(revoked.claim, { kind: 'blocked' });
  const stored = await admin.query('select status,error_code from public.supervisor_run_steps where run_id=$1', [backlog.id]);
  assert.deepEqual(stored.rows, [{ status: 'blocked', error_code: 'authorization_revoked' }]);
  assert.equal(await take(a), null);
  // Simulate a crash after the atomic claim. No dispatch hold may hide an
  // expired lease. Both connections compete without replaying an active step.
  await admin.query("update public.supervisor_run_steps set lease_until=clock_timestamp() where run_id=$1", [coldRun.id]);
  const raced = (await Promise.all([take(a), take(b)])).filter(Boolean);
  assert.equal(raced.length, 1);
  assert.equal(raced[0].run_id, coldRun.id);
  assert.equal(raced[0].claim.step.attempts, 2);
  assert.notEqual(raced[0].claim.step.claim_token, second.claim.step.claim_token);
  console.log('Verified engine-scoped fair dispatch, revoked-work disposition and atomic lease recovery.');
}

try {
  await admin.connect();
  for (const db of workers) {
    await db.connect();
    await db.query("set role service_role; set request.jwt.claim.role = 'service_role'");
  }
  const [a, b] = workers;
  await verifyWorkforceProfiles({ admin, a, b, first: await fixture(), second: await fixture() });
  await verifyFleetDispatch(a, b);
  const followups = await fixture();
  await verifyLegacyFollowups({ admin, a, b, scope: followups.scope, run: await admit(a, followups) });
  const legacy = await fixture();
  const replacement = await fixture();
  await a.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true)', [replacement.scope[0]]);
  for (const [engine, other, cafe] of [['legacy', 'replacement', legacy], ['replacement', 'legacy', replacement]]) {
    const [run, duplicate] = await Promise.all(workers.map(db => admit(db, cafe)));
    assert.equal(run.id, duplicate.id);
    assert.equal(run.engine, engine);
    assert.equal(run.employee_key, engine === 'replacement' ? 'general_manager' : null);
    assert.equal(duplicate.employee_key, run.employee_key);
    assert.equal(run.execution_version, 2);
    assert.equal(duplicate.engine, engine);
    const [wrong, first] = await Promise.all([claim(a, other, cafe.scope, run), claim(b, engine, cafe.scope, run)]);
    assert.deepEqual(wrong, { kind: 'busy' });
    assert.equal(first.kind, 'claimed');
    assert.equal(first.step.attempts, 1);
    assert.equal(first.step.step_key, 'authorize_owner');
    assert.deepEqual(await claim(a, engine, cafe.scope, run), { kind: 'busy' });
  }

  const result = await fixture();
  await a.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true)', [result.scope[0]]);
  await verifyResult({ admin, a, b, scope: result.scope, run: await admit(a, result) });

  const steering = await fixture();
  await a.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true)', [steering.scope[0]]);
  await verifySteering({ admin, a, b, scope: steering.scope, run: await admit(a, steering), otherScope: legacy.scope });

  const run = await admit(a, replacement);
  await assert.rejects(admin.query("update public.supervisor_runs set employee_key='growth' where id=$1", [run.id]),
    /assignment_identity_is_immutable/);
  await a.query('update public.luna_rollouts set enabled=false where business_id=$1', [replacement.scope[0]]);
  const replay = await admit(b, replacement);
  assert.equal(replay.engine, 'replacement');
  assert.equal(replay.employee_key, 'general_manager');
  const newLegacy = await a.query(`select public.supervisor_run_start($1,$2,$3,$4,$5,'[{"key":"read","retry":"idempotent"}]') as run`,
    [...replacement.scope, randomUUID(), 'b'.repeat(64)]);
  assert.equal(newLegacy.rows[0].run.engine, 'legacy');
  await assert.rejects(a.query("update public.supervisor_runs set engine='legacy' where id=$1", [run.id]),
    /assignment_identity_is_immutable/);
  await assert.rejects(claim(b, 'replacement', legacy.scope, run), /run_not_found/);

  const expired = await admin.query(`update public.supervisor_run_steps set lease_until=clock_timestamp()-interval '1 second'
    where run_id=$1 and status='leased' returning claim_token`, [run.id]);
  const [one, two] = await Promise.all(workers.map(db => claim(db, 'replacement', replacement.scope, run)));
  assert.deepEqual([one.kind, two.kind].sort(), ['busy', 'claimed']);
  const recovered = one.kind === 'claimed' ? one.step : two.step;
  assert.equal(recovered.attempts, 2);
  const staleToken = expired.rows[0].claim_token;
  assert.notEqual(recovered.claim_token, staleToken);
  await assert.rejects(a.query("select public.supervisor_run_complete_step($1,$2,$3,$4,'authorize_owner',$5,'owner:stale')",
    [...replacement.scope, run.id, staleToken]), /step_claim_conflict/);
  await admin.query('delete from public.memberships where business_id=$1 and user_id=$2', replacement.scope.slice(0, 2));
  await assert.rejects(claim(b, 'replacement', replacement.scope, run), /run_owner_required/);
  for (const role of ['anon', 'authenticated']) {
    const privileges = await admin.query(`select
      has_function_privilege($1,'public.luna_assignment_claim(uuid,uuid,uuid,uuid,uuid,integer)','execute') as claim,
      has_table_privilege($1,'public.luna_rollouts','update') as rollout`, [role]);
    assert.deepEqual(privileges.rows[0], { claim: false, rollout: false });
  }
  await assert.rejects(a.query('select luna_internal.supervisor_run_claim(null,null,null,null,null,60)'), /permission denied/);
  console.log('Verified concurrent owner admission, both engine claim entries, rollback, tenant isolation, lease recovery and revocation.');
} finally {
  try {
    for (const { business, owner } of fixtures) {
      await admin.query('delete from public.businesses where id=$1', [business]);
      await admin.query('delete from auth.users where id=$1', [owner]);
    }
  } finally {
    await Promise.all([...workers, admin].map(db => db.end()));
  }
}
