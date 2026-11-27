// Architecture acceptance. The future test driver supplies real entry points, a disposable
// business and deterministic transport. The oracle owns the effect destination and SQL reads.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { replacement } from '../guards/luna-boundary.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

export function verifyRace({pin, executions, deliveries, runs, effects, token}) {
  assert.deepEqual(executions,[pin], 'only the pinned engine may start this single-step assignment');
  assert.deepEqual(deliveries,[token], 'the independent destination must receive one effect');
  assert.equal(runs.length,1,'one durable logical assignment');
  assert.equal(runs[0].status,'completed');
  assert.equal(runs[0].engine,pin);
  assert.equal(effects.length,1,'one effect reservation across both engines');
  assert.equal(effects[0].state,'verified');
  assert.equal(effects[0].receipt_ref,token);
}

async function run(connectionString) {
  const u = new URL(connectionString);
  assert.ok(['127.0.0.1','localhost'].includes(u.hostname) && u.port==='54322' && u.pathname==='/postgres','disposable Supabase required');
  const db = new Client({connectionString});
  await db.connect();
  try {
    // Check the actual migrated catalogs even before a replacement engine exists.
    const keys=await db.query(`select c.conrelid::regclass::text as relation,
      array_agg(a.attname::text order by k.ordinality) as columns
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum,ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
      where c.contype in ('p','u') and c.conrelid in
        ('public.supervisor_runs'::regclass,'public.supervisor_effect_attempts'::regclass)
      group by c.oid,c.conrelid`);
    for (const [table,identity] of [['supervisor_runs',['business_id','owner_user_id','request_key']],
      ['supervisor_effect_attempts',['business_id','proposal_id','effect_hash']]]) {
      assert.ok(keys.rows.some(k => k.relation.split('.').at(-1)===table &&
        k.columns.length===identity.length && identity.every(c => k.columns.includes(c))),
        table+' must enforce the shared logical identity');
    }
    const paths=execFileSync('git',['ls-files','-z','--','lib/luna','components/luna','app/api/luna'],{encoding:'utf8'});
    if (!paths.split('\0').some(replacement)) {
      console.log('Migrated run and effect uniqueness verified. Two-engine execution awaits the replacement.');
      return;
    }
    const { prepareRace } = await import('./luna-engine-driver.mjs');
    for (const pin of ['legacy','replacement']) {
      const requestKey=randomUUID(), token=randomUUID(), executions=[], deliveries=[];
      const server=createServer((req,res) => {
        deliveries.push(req.method==='POST' && req.url==='/'+token ? token : 'unexpected delivery');
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({receipt:token}));
      });
      server.listen(0,'127.0.0.1');
      await once(server,'listening');
      try {
        const trial=await prepareRace({db,pin,requestKey,
          destination:'http://127.0.0.1:'+server.address().port+'/'+token,
          onProviderStart:engine => executions.push(engine)});
        // Both entry points compete for the same assignment and approved proposal.
        await Promise.all([trial.dispatch('legacy'),trial.dispatch('replacement')]);
        await trial.recover();
        const runs=await db.query('select status, engine from public.supervisor_runs where business_id=$1 and owner_user_id=$2 and request_key=$3',
          [trial.businessId,trial.ownerId,requestKey]);
        const effects=await db.query('select state, receipt_ref from public.supervisor_effect_attempts where business_id=$1 and proposal_id=$2',
          [trial.businessId,trial.proposalId]);
        verifyRace({pin,executions,deliveries,runs:runs.rows,effects:effects.rows,token});
      } finally {
        await new Promise((resolve,reject) => server.close(err => err ? reject(err) : resolve()));
      }
    }
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await run(process.env.SUPERVISOR_RUN_DB_URL);
