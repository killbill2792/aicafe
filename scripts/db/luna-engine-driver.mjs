import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const postgrestImage = 'postgrest/postgrest:v14.5@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function startDatabaseApi(connection) {
  const probe = createServer();
  const origin = await listen(probe);
  await close(probe);
  const name = `aicafe-luna-race-${randomUUID()}`;
  const jwtSecret = randomBytes(48).toString('hex');
  const jwtPart = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  const jwt = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}.${jwtPart({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const serviceKey = `${jwt}.${createHmac('sha256', jwtSecret).update(jwt).digest('base64url')}`;
  connection.username = 'authenticator';
  execFileSync('docker', ['run', '--rm', '-d', '--network', 'host', '--name', name,
    '-e', `PGRST_DB_URI=${connection}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_SERVER_PORT=${new URL(origin).port}`, '-e', 'PGRST_SERVER_HOST=127.0.0.1',
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`, postgrestImage], { timeout: 120_000 });
  const stop = () => execFileSync('docker', ['stop', '-t', '1', name], { timeout: 10_000, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const result = await fetch(`${origin}/businesses?select=id&limit=1`, {
          headers: { authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(1000),
        });
        if (result.ok) return { origin, serviceKey, stop };
      } catch { /* Database API is starting. */ }
      await delay(250);
    }
    throw new Error('Disposable PostgREST did not become ready');
  } catch (error) {
    stop();
    throw error;
  }
}

async function simulatedGmail(destination) {
  const prefix = '/gmail/v1/users/me/messages';
  let delivery;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    try {
      assert.equal(request.headers.authorization, 'Bearer disposable-gmail-access');
      if (request.method === 'POST' && url.pathname === `${prefix}/send`) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const mime = Buffer.from(JSON.parse(body).raw, 'base64url').toString('utf8');
        const messageId = /^Message-ID:\s*(<[^>]+>)\r?$/mi.exec(mime)?.[1];
        assert.ok(messageId);
        const result = await fetch(destination, { method: 'POST', body, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
        assert.ok(result.ok);
        const { id } = await result.json();
        assert.ok(id);
        delivery = { id, messageId };
        // The destination accepted it, but the caller did not receive its acknowledgement.
        send(503, { error: 'simulated acknowledgement loss' });
      } else if (request.method === 'GET' && url.pathname === prefix) {
        const match = delivery && url.searchParams.get('q') === `rfc822msgid:${delivery.messageId}`;
        send(200, { messages: match ? [{ id: delivery.id }] : [] });
      } else if (request.method === 'GET' && delivery && url.pathname === `${prefix}/${delivery.id}`) {
        send(200, { id: delivery.id, labelIds: ['SENT'], payload: { headers: [{ name: 'Message-ID', value: delivery.messageId }] } });
      } else {
        send(404, {});
      }
    } catch {
      send(500, { error: 'invalid simulated Gmail request' });
    }
  });
  return { origin: await listen(server), stop: () => close(server) };
}

function startWorker(engine, api, gmail, encryptionKey, onProviderStart) {
  const child = fork(fileURLToPath(new URL('./luna-race/worker.mjs', import.meta.url)), [], {
    execArgv: [],
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: api.origin,
      SUPABASE_SERVICE_ROLE_KEY: api.serviceKey, TOKEN_ENCRYPTION_KEY: encryptionKey,
      SUPERVISOR_RUN_WORKER_ENABLED: 'true', SUPERVISOR_DURABLE_CHAT_ENABLED: 'true',
      ...(engine === 'legacy' ? { AI_CAFE_LIVE_ACCEPTANCE: 'OWNER_APPROVED_LOCAL_ONLY' } : {}),
      OPENAI_API_KEY: 'disposable-responses-key', AICAFE_RACE_ENGINE: engine, AICAFE_RACE_GMAIL: gmail.origin,
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const pending = new Map();
  let startError;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  child.on('message', message => {
    if (message.type === 'ready') { ready(); return; }
    if (message.type === 'provider-start') { onProviderStart(engine); return; }
    pending.get(message.id)?.(message);
  });
  const fail = error => {
    startError = error;
    ready();
    for (const reply of pending.values()) reply({ error: error.message });
  };
  child.once('error', fail);
  child.once('exit', code => fail(new Error(`Luna race ${engine} worker exited with ${code}`)));
  return {
    async call(command, ...args) {
      await Promise.race([started, delay(30_000, undefined, { ref: false }).then(() => { throw new Error(`Luna race ${engine} worker startup timed out`); })]);
      if (startError) throw startError;
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => pending.get(id)?.({ error: `Luna race ${engine} ${command} timed out` }), 65_000);
        pending.set(id, message => {
          clearTimeout(timer);
          pending.delete(id);
          if (message.error) reject(new Error(message.error));
          else resolve(message.value);
        });
        child.send({ id, command, args }, error => {
          if (error) pending.get(id)?.({ error: error.message });
        });
      });
    },
    stop: () => child.kill(),
  };
}

export async function prepareRace({ db, pin, requestKey, destination, onProviderStart }) {
  const connection = new URL(process.env.SUPERVISOR_RUN_DB_URL);
  assert.equal(connection.protocol, 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost'].includes(connection.hostname) && connection.port === '54322' && connection.pathname === '/postgres');
  const target = new URL(destination);
  assert.ok(target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.port && /^\/[\da-f-]{36}$/i.test(target.pathname));
  assert.ok(pin === 'legacy' || pin === 'replacement');
  const businessId = randomUUID(), ownerId = randomUUID(), threadId = randomUUID();
  const scope = { businessId, ownerUserId: ownerId, threadId, locale: 'en' };
  await db.query("insert into auth.users(id,aud,role,email) values ($1,'authenticated','authenticated',$2)", [ownerId, `${ownerId}@example.invalid`]);
  await db.query("insert into public.businesses(id,name,timezone) values ($1,'Luna engine race',current_setting('TimeZone'))", [businessId]);
  await db.query(`insert into public.cafe_access(business_id,mode) values ($1,'grandfathered')
    on conflict (business_id) do update set mode=excluded.mode`, [businessId]);
  await db.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')", [businessId, ownerId]);
  await db.query('insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)', [threadId, businessId, ownerId, randomUUID()]);
  await db.query(`insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
    values ($1,$2,$3,$4,$3,'owner','text','Prepare a shift report.',$5)`, [requestKey, businessId, ownerId, threadId, randomUUID()]);
  await db.query('insert into public.luna_rollouts(business_id,enabled) values ($1,$2)', [businessId, pin === 'replacement']);

  const api = await startDatabaseApi(connection);
  const gmail = await simulatedGmail(target).catch(error => { api.stop(); throw error; });
  const encryptionKey = randomBytes(32).toString('base64');
  const workers = Object.fromEntries(['legacy', 'replacement'].map(engine => [engine, startWorker(engine, api, gmail, encryptionKey, onProviderStart)]));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const worker of Object.values(workers)) worker.stop();
    try { await gmail.stop(); } finally { api.stop(); }
  };
  const abandon = async () => {
    try { await stop(); } finally {
      await db.query('delete from public.businesses where id=$1', [businessId]);
      await db.query('delete from auth.users where id=$1', [ownerId]);
    }
  };
  try {
    const { runId, proposalId, revision } = await workers.legacy.call('prepare', scope, requestKey);
    const dispatch = (engine) => workers[engine].call('dispatch', scope, runId);
    return {
      businessId, ownerId, proposalId,
      async dispatch(engine) {
        try {
          const result = await dispatch(engine);
          if (result === 'completed') {
            await assert.rejects(workers[engine].call('commit', scope, proposalId, revision), /gmail_provider_request_failed/);
          } else assert.equal(result, 'busy');
        } catch (error) { await abandon(); throw error; }
      },
      async recover() {
        try {
          const attempt = await db.query(`select e.state, r.provider_message_id, r.provider_accepted_at
            from public.supervisor_effect_attempts e join public.connector_provider_receipts r using (business_id, proposal_id, effect_hash)
            where e.business_id=$1 and e.proposal_id=$2`, [businessId, proposalId]);
          assert.deepEqual(attempt.rows, [{ state: 'uncertain', provider_message_id: null, provider_accepted_at: null }]);
          for (const engine of ['legacy', 'replacement']) {
            assert.equal(await dispatch(engine), engine === pin ? 'completed' : 'busy');
          }
          await assert.rejects(workers[pin].call('commit', scope, proposalId, revision), /Approval required/);
          const recovered = await workers[pin].call('recover', scope, proposalId);
          assert.equal(recovered.status, 'committed');
          console.log(`Luna ${pin} pin recovered the simulated Gmail acknowledgement without a second send.`);
        } finally { await stop(); }
      },
    };
  } catch (error) {
    await abandon();
    throw error;
  }
}
