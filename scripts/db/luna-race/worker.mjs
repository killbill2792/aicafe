import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const engine = process.env.AICAFE_RACE_ENGINE;
const database = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
const gmail = new URL(process.env.AICAFE_RACE_GMAIL);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(gmail.hostname, '127.0.0.1');
assert.ok(engine === 'legacy' || engine === 'replacement');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === database.origin && url.pathname.startsWith('/rest/v1/')) {
    const target = new URL(url.pathname.slice('/rest/v1'.length) + url.search, database);
    return nativeFetch(new Request(target, request));
  }
  if (url.origin === 'https://gmail.googleapis.com' && url.pathname.startsWith('/gmail/v1/users/me/')) {
    const target = new URL(url.pathname + url.search, gmail);
    return nativeFetch(new Request(target, request));
  }
  if (url.href === 'https://api.openai.com/v1/responses' && request.method === 'POST') {
    const { model } = await request.json();
    process.send({ type: 'provider-start' });
    const text = 'The shift report is ready for delivery.';
    const item = { type: 'message', role: 'assistant', id: 'msg_luna_race', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: 'resp_luna_race', model, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 12 } };
    const events = [
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error(`Luna race blocked unexpected transport to ${url.origin}${url.pathname}`);
};

const vite = await createServer({
  configFile: false, appType: 'custom', server: { middlewareMode: true, watch: null, ws: false },
  resolve: { alias: { '@': process.cwd(), 'server-only': resolve('lib/testing/serverOnlyStub.ts') } },
});
try {
  const entries = await vite.ssrLoadModule('/scripts/db/luna-race/entries.ts');
  const actions = { prepare: entries.prepare, dispatch: (...args) => entries.dispatch(engine, ...args), commit: entries.commit, recover: entries.recover };
  process.on('message', async ({ id, command, args }) => {
    try {
      assert.ok(Object.hasOwn(actions, command));
      process.send({ id, value: await actions[command](...args) });
    } catch (error) {
      process.send({ id, error: [error.message, error.cause?.message, error.cause?.detail].filter(Boolean).join(' / ') });
    }
  });
  process.once('disconnect', async () => { await vite.close(); });
  process.send({ type: 'ready' });
} catch (error) {
  await vite.close();
  throw error;
}
