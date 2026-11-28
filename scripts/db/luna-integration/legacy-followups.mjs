import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyLegacyFollowups({ admin, a, b, scope, run }) {
  const claim = async () => (await a.query('select public.supervisor_run_claim($1,$2,$3,$4,$5,60) as claim',
    [...scope, run.id, randomUUID()])).rows[0].claim.step;
  const authorization = await claim();
  await a.query("select public.supervisor_run_complete_step($1,$2,$3,$4,'authorize_owner',$5,$6)",
    [...scope, run.id, authorization.claim_token, 'owner:' + run.request_key]);
  const turn = await claim();
  const lease = [...scope, run.id, turn.claim_token];
  const job = (await a.query('select public.supervisor_start_owner_job_v2($1,$2,$3,$4,$5) as job', lease)).rows[0].job;

  async function followup(text) {
    const request = randomUUID();
    await admin.query(`insert into public.ai_messages
      (id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
      values ($1,$2,$3,$4,$3,'owner','text',$5,$6)`, [request, ...scope, text, randomUUID()]);
    return (await b.query(`select public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,'en','{}') as run`,
      [...scope, request, 'a'.repeat(64)])).rows[0].run;
  }
  const legacy = await followup('Compare with the earlier shift.');
  await b.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true)', [scope[0]]);
  const replacement = await followup('Check the current inventory separately.');
  await b.query('update public.luna_rollouts set enabled=false where business_id=$1', [scope[0]]);
  const afterReplacement = await followup('Review attention items.');
  assert.deepEqual([run.engine, legacy.engine, replacement.engine, afterReplacement.engine],
    ['legacy', 'legacy', 'replacement', 'legacy']);
  const collected = await a.query('select public.supervisor_collect_owner_followups_v2($1,$2,$3,$4,$5,$6) as messages',
    [...lease, job.id]);
  assert.deepEqual(collected.rows[0].messages, [{ id: legacy.request_key, text: 'Compare with the earlier shift.' }]);

  // Simulate a checkpoint saved by a worker using the pre-fence collector.
  const absorbedOwnerMessageIds = [legacy.request_key, replacement.request_key];
  await a.query('select public.supervisor_research_checkpoint_v2($1,$2,$3,$4,$5,$6,true,$7)',
    [...lease, turn.checkpoint_seq, { followUpIds: absorbedOwnerMessageIds }]);
  const replyId = randomUUID();
  const grounding = { status: 'answered', ownerMessageId: run.request_key, durableRunId: run.id,
    agentMetadata: { endReason: 'complete', absorbedOwnerMessageIds } };
  const published = await a.query('select public.supervisor_publish_owner_reply_v2($1,$2,$3,$4,$5,$6,$7,$8,$9) as reply',
    [...lease, job.id, replyId, JSON.stringify([{ type: 'text', text: 'I compared the two shifts.' }]), grounding]);
  assert.deepEqual(published.rows[0].reply.grounding.agentMetadata.absorbedOwnerMessageIds, [legacy.request_key]);
  const states = await admin.query(`select id,status,final_report_ref from public.supervisor_runs where id=any($1::uuid[])
    order by created_at,id`, [[legacy.id, replacement.id, afterReplacement.id]]);
  assert.deepEqual(states.rows, [
    { id: legacy.id, status: 'completed', final_report_ref: replyId },
    { id: replacement.id, status: 'pending', final_report_ref: null },
    { id: afterReplacement.id, status: 'pending', final_report_ref: null },
  ]);
  const steps = await admin.query('select distinct status from public.supervisor_run_steps where run_id=$1', [replacement.id]);
  assert.deepEqual(steps.rows, [{ status: 'pending' }]);
  console.log('Verified legacy follow-up collection and settlement preserve same-thread replacement work.');
}
