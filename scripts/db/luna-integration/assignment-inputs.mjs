import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifySteering({ admin, a, b, scope, run, otherScope }) {
  const identity = [...scope, run.id];
  const steer = async (db, request, text, target = identity) => (await db.query(
    'select public.luna_steer_assignment($1,$2,$3,$4,$5,$6) as input', [...target, request, text])).rows[0].input;
  const key = randomUUID();
  const first = await Promise.all([steer(a, key, 'Focus on waste.'), steer(b, key, 'Focus on waste.')]);
  assert.deepEqual(first[0], first[1]);
  assert.equal(first[0].position, 1);
  await assert.rejects(steer(a, key, 'Different text.'), /input_request_conflict/);
  await assert.rejects(steer(a, key, 'Focus on waste.', [...otherScope, run.id]), /assignment_input_denied/);
  await assert.rejects(a.query("select public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,'en','{}')",
    [...scope, first[0].message_id, 'a'.repeat(64)]), /message_already_steers_assignment/);

  const accepted = await Promise.all(['Include receipts.', 'Compare with yesterday.'].map((text, index) =>
    steer(index ? a : b, randomUUID(), text)));
  const ordered = [first[0], ...accepted].sort((x, y) => x.position - y.position);
  assert.deepEqual(ordered.map(input => input.position), [1, 2, 3]);
  const claim = async () => (await a.query('select public.luna_assignment_claim($1,$2,$3,$4,$5,60) as claim',
    [...identity, randomUUID()])).rows[0].claim.step;
  const authorize = await claim();
  await a.query("select public.supervisor_run_complete_step($1,$2,$3,$4,'authorize_owner',$5,$6)",
    [...identity, authorize.claim_token, 'owner:' + scope[1]]);
  let step = await claim();
  assert.equal(step.step_key, 'owner_turn');
  const checkpoint = async (operation, action, receipt = null) => {
    step = (await a.query('select public.supervisor_checkpoint_owner_run_v2($1,$2,$3,$4,$5,$6,$7,$8,null,$9) as step',
      [...identity, step.claim_token, step.checkpoint_seq, operation, action, receipt])).rows[0].step;
  };
  const read = async (operation, token = step.claim_token, after = 0, limit = 10) => (await b.query(
    'select * from public.luna_provider_inputs($1,$2,$3,$4,$5,$6,$7,$8)',
    [...identity, token, operation, after, limit])).rows;
  const op = randomUUID();
  await checkpoint(op, 'begin_provider');
  const late = await steer(b, randomUUID(), 'Show amounts by shift.');
  assert.equal(late.position, 4);
  const page = await read(op, step.claim_token, 0, 2);
  assert.deepEqual(page.map(x => x.message_id), ordered.slice(0, 2).map(x => x.message_id));
  assert.equal(page[0].content, 'Focus on waste.');
  assert.deepEqual((await read(op, step.claim_token, Number(page[1].position))).map(x => x.message_id),
    [ordered[2].message_id]);
  const expired = step.claim_token;
  await admin.query("update public.supervisor_run_steps set lease_until=clock_timestamp() where id=$1", [step.id]);
  await assert.rejects(read(op), /input_claim_conflict/);
  step = await claim();
  await assert.rejects(read(op, expired), /input_claim_conflict/);
  assert.deepEqual((await read(op)).map(x => x.message_id), ordered.map(x => x.message_id));
  await checkpoint(op, 'complete', 'abandoned:' + op);
  const retry = randomUUID();
  await checkpoint(retry, 'begin_provider');
  assert.deepEqual((await read(retry)).map(x => x.message_id), [...ordered, late].map(x => x.message_id));
  await checkpoint(retry, 'complete', 'provider:' + retry);
  const next = randomUUID();
  await checkpoint(next, 'begin_provider');
  assert.deepEqual(await read(next), []);
  const cancelled = await b.query('select public.supervisor_cancel_owner_run_v2($1,$2,$3,$4) as result', identity);
  assert.equal(cancelled.rows[0].result, 'cancelled');
  await assert.rejects(read(next), /assignment_input_denied|input_claim_conflict/);
  assert.deepEqual(await steer(a, key, 'Focus on waste.'), first[0]);
  await assert.rejects(steer(b, randomUUID(), 'Too late.'), /assignment_closed_to_steering/);
  await admin.query('delete from public.memberships where business_id=$1 and user_id=$2', scope.slice(0, 2));
  await assert.rejects(steer(a, key, 'Focus on waste.'), /assignment_input_denied/);
  console.log('Verified ordered steering, stable paged provider input, abandonment, lease recovery and cancellation.');
}
