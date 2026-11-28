import assert from 'node:assert/strict';

const read = (db, cafe) => db.query(`select employee_key,display_name,job_title
  from public.luna_workforce_profiles where business_id=$1`, [cafe.scope[0]]);
const save = (db, cafe, key, name, title) => db.query(`select public.luna_save_workforce_profile($1,$2,$3,$4)`,
  [cafe.scope[0], key, name, title]);

async function asOwner(db, cafe, operation) {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
      [cafe.scope[1]]);
    const result = await operation();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

export async function verifyWorkforceProfiles({ a, b, admin, first, second }) {
  const key = 'growth';
  assert.deepEqual((await asOwner(a, first, () => read(a, first))).rows, []);
  await asOwner(a, first, () => save(a, first, key, 'Andrea', null));
  await asOwner(b, second, () => save(b, second, key, 'Taylor', 'Customer Lead'));
  assert.deepEqual((await asOwner(b, second, () => read(b, first))).rows, []);
  await assert.rejects(() => asOwner(b, second, () => save(b, first, key, 'Overwritten', null)), { code: '42501' });
  await assert.rejects(() => asOwner(a, first, () => save(a, first, 'Alex', 'Name used as a key', null)), { code: '23514' });
  await assert.rejects(() => asOwner(a, first, () => a.query(`update public.luna_workforce_profiles
    set employee_key='staffing' where business_id=$1`, [first.scope[0]])), { code: '42501' });
  assert.deepEqual((await asOwner(a, first, () => read(a, first))).rows,
    [{ employee_key: key, display_name: 'Andrea', job_title: null }]);
  await asOwner(a, first, () => save(a, first, key, null, 'Growth Lead'));
  assert.deepEqual((await asOwner(a, first, () => read(a, first))).rows,
    [{ employee_key: key, display_name: null, job_title: 'Growth Lead' }]);
  assert.deepEqual((await asOwner(b, second, () => read(b, second))).rows,
    [{ employee_key: key, display_name: 'Taylor', job_title: 'Customer Lead' }]);
  await admin.query("update public.memberships set role='manager' where business_id=$1 and user_id=$2", first.scope.slice(0, 2));
  assert.deepEqual((await asOwner(a, first, () => read(a, first))).rows, []);
  await assert.rejects(() => asOwner(a, first, () => save(a, first, key, 'Revoked owner', null)), { code: '42501' });
  console.log('Verified stable workforce keys, default resets and café-scoped owner-only profile writes.');
}
