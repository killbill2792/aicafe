import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyResult({ admin, a, b, scope, run }) {
  const identity = [...scope, run.id];
  const claim = async () => (await a.query('select public.luna_assignment_claim($1,$2,$3,$4,$5,60) as work',
    [...identity, randomUUID()])).rows[0].work.step;
  const authorization = await claim();
  await a.query("select public.supervisor_run_complete_step($1,$2,$3,$4,'authorize_owner',$5,$6)",
    [...identity, authorization.claim_token, 'owner:' + run.request_key]);
  let turn = await claim();
  const token = turn.claim_token;
  const job = (await a.query('select public.supervisor_start_owner_job_v2($1,$2,$3,$4,$5) as job',
    [...identity, token])).rows[0].job;
  const respond = async () => {
    const operation = randomUUID();
    for (const [action, receipt] of [['begin_provider', null], ['complete', 'provider:' + operation]]) {
      turn = (await a.query('select public.supervisor_checkpoint_owner_run_v2($1,$2,$3,$4,$5,$6,$7,$8,null,$9) as step',
        [...identity, token, turn.checkpoint_seq, operation, action, receipt])).rows[0].step;
    }
    return operation;
  };
  const old = await respond();
  const reply = randomUUID();
  const blocks = [{ type: 'text', text: 'The afternoon figures are still incomplete.' }];
  const grounding = { status: 'partial', ownerMessageId: run.request_key, durableRunId: run.id, agentMetadata: { endReason: 'complete' } };
  const commit = (db, op, payload = blocks, fence = token) => db.query(
    'select public.luna_commit_assignment_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as receipt',
    [...identity, fence, job.id, turn.checkpoint_seq, op, reply, JSON.stringify(payload), grounding]);
  await b.query("select public.luna_steer_assignment($1,$2,$3,$4,$5,'Check the afternoon.')", [...identity, randomUUID()]);
  await assert.rejects(commit(a, old), /assignment_has_new_input/);
  assert.equal((await admin.query('select id from public.ai_messages where id=$1', [reply])).rowCount, 0);
  const final = await respond();
  await assert.rejects(commit(b, old), /checkpoint_conflict/);
  await assert.rejects(commit(b, final, blocks, randomUUID()), /checkpoint_conflict/);
  // Exercise rollback after the message writer succeeds but final verification
  // cannot acquire its step. No message, completed turn or done job can leak.
  await admin.query("update public.supervisor_run_steps set next_retry_at=now()+interval '1 hour' where run_id=$1 and step_key='verify_report'", [run.id]);
  await assert.rejects(commit(a, final), /verification_unavailable/);
  assert.equal((await admin.query('select id from public.ai_messages where id=$1', [reply])).rowCount, 0);
  assert.equal((await admin.query('select status from public.ai_agent_jobs where id=$1', [job.id])).rows[0].status, 'running');
  await admin.query("update public.supervisor_run_steps set next_retry_at=null where run_id=$1 and step_key='verify_report'", [run.id]);
  const published = await Promise.all([commit(a, final), commit(b, final)]);
  assert.deepEqual(published.map(x => x.rows[0].receipt), [reply, reply]);
  await assert.rejects(commit(b, final, [{ type: 'text', text: 'Other content.' }]), /assignment_result_conflict/);
  const state = await admin.query(`select r.status, r.final_report_ref, j.reply_message_id, m.structured_content,
    (select count(*)::int from public.supervisor_run_steps s where s.run_id=r.id and s.status='completed') as steps
    from public.supervisor_runs r join public.ai_agent_jobs j on j.durable_run_id=r.id
    join public.ai_messages m on m.id=j.reply_message_id where r.id=$1`, [run.id]);
  assert.deepEqual(state.rows, [{ status: 'completed', final_report_ref: reply, reply_message_id: reply, structured_content: blocks, steps: 3 }]);
  await admin.query('delete from public.memberships where business_id=$1 and user_id=$2', scope.slice(0, 2));
  await assert.rejects(commit(a, final), /assignment_result_denied/);
  console.log('Verified atomic result publication, late steering, rollback, exact replay and revoked access.');
}
