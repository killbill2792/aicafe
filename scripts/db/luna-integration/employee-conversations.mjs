import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyEmployeeConversations({ admin, a, b, first, second }) {
  const [businessId, ownerId] = first.scope;
  const [foreignBusiness] = second.scope;
  const open = (db, business, owner, employee) => db.query('select public.luna_open_employee_thread($1,$2,$3) as thread',
    [business, owner, employee]).then(result => result.rows[0].thread);
  await assert.rejects(open(a, businessId, ownerId, 'operations'), /luna_employee_thread_disabled/);
  await a.query('insert into public.luna_rollouts(business_id,enabled) values ($1,true)', [businessId]);
  await assert.rejects(open(a, foreignBusiness, ownerId, 'operations'), /luna_employee_thread_denied/);
  await assert.rejects(open(a, businessId, ownerId, 'Maya'), /luna_employee_thread_denied/);
  const [thread, replay] = await Promise.all([open(a, businessId, ownerId, 'operations'), open(b, businessId, ownerId, 'operations')]);
  assert.equal(thread, replay);
  assert.notEqual(await open(a, businessId, ownerId, 'finance'), thread);
  const insertMessage = async () => {
    const request = randomUUID();
    await admin.query(`insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
      values ($1,$2,$3,$4,$3,'owner','text','Check today’s stock.',$5)`, [request, businessId, ownerId, thread, randomUUID()]);
    return request;
  };
  const admit = request => a.query("select public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,'en','{}') as run",
    [businessId, ownerId, thread, request, 'a'.repeat(64)]).then(result => result.rows[0].run);
  const request = await insertMessage();
  const run = await admit(request);
  assert.equal(run.engine, 'replacement');
  assert.equal(run.employee_key, 'operations');
  await admin.query('insert into public.luna_workforce_profiles(business_id,employee_key,display_name) values ($1,$2,$3)',
    [businessId, 'operations', 'New display name']);
  assert.equal(await open(a, businessId, ownerId, 'operations'), thread);
  await a.query('update public.luna_rollouts set enabled=false where business_id=$1', [businessId]);
  assert.equal(await open(a, businessId, ownerId, 'operations'), thread);
  assert.equal((await admit(request)).employee_key, 'operations');
  await assert.rejects(admit(await insertMessage()), /luna_employee_thread_disabled/);
  await admin.query("update public.memberships set role='manager' where business_id=$1 and user_id=$2", [businessId, ownerId]);
  await assert.rejects(open(b, businessId, ownerId, 'operations'), /luna_employee_thread_denied/);
  console.log('Verified stable direct employee conversations, immutable run ownership, and revocation.');
}
