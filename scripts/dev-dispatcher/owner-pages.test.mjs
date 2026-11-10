import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerSnapshot, statusLevel, freshness,
  PUBLIC_COMMENT_URL, PRIVATE_QUEUE_URL, REFRESH_INTERVAL_MS, refresh } from '../../docs/owner-dashboard.mjs';

const sample=[
  '<!-- aicafe-dispatcher-owner-view:v1 -->',
  '## AI CAFE — live owner control center',
  '**Last successful GitHub reconciliation shown:** 2026-11-09T22:55:14.979Z (UTC)',
  '**Private ledger as-of:** 2026-11-09T22:54:46.168Z',
  '### What is happening',
  '| Task | PR | Stage | CI | Codex | Muse | Next responsible party |',
  '|---|---|---|---|---|---|---|---|',
  '| POS0e | [#404](https://github.com/killbill2792/aicafe/pull/404) | Draft | success | findings | no active delivery | Owner decision + coder can continue signed work |',
  '| POS0c | [#406](https://github.com/killbill2792/aicafe/pull/406) | Draft | failure | findings | repair_ci: queued (not sent) | Owner decision + coder can continue signed work |',
  '### Needs owner approval (no approvals inferred from alert delivery)',
  '- **POS0c [#406](https://github.com/killbill2792/aicafe/pull/406):** Approve narrowly scoped CI runner edit? [Open original GitHub question](https://github.com/killbill2792/aicafe/pull/406#issuecomment-6752771905). Muse notification: **not yet confirmed**; owner approval: **still pending**.',
  '### Muse delivery and retries',
  'No secret prompts here.'
].join('\n');

test('public owner status parser honors real issue comment marker, PR links and approval sources',()=>{
 const output=parseOwnerSnapshot(sample);
 assert.equal(output.tasks.length,2);
 assert.deepEqual(output.tasks[1],{
  id:'POS0c',pr:406,url:'https://github.com/killbill2792/aicafe/pull/406',
  stage:'Draft',ci:'failure',codex:'findings',
  muse:'repair_ci: queued (not sent)',
  next:'Owner decision + coder can continue signed work'
 });
 assert.equal(output.decisions.length,1);
 assert.match(output.decisions[0].text,/Approve narrowly scoped CI runner edit/);
 assert.equal(output.decisions[0].url,'https://github.com/killbill2792/aicafe/pull/406#issuecomment-6752771905');
 assert.equal(output.checkedAt,'2026-11-09T22:55:14.979Z');
 assert.equal(output.ledgerAt,'2026-11-09T22:54:46.168Z');
});
test('public dashboard refuses arbitrary body and does not follow unsafe URLs',()=>{
 assert.throws(()=>parseOwnerSnapshot('## Fake queue'),/trusted public status projection/);
 const malicious=sample.replace(
  '[Open original GitHub question](https://github.com/killbill2792/aicafe/pull/406#issuecomment-6752771905)',
  '[Open original GitHub question](https://evil.example/private#issuecomment-6752771905)');
 assert.notEqual(malicious,sample);
 const parsed=parseOwnerSnapshot(malicious);
 assert.equal(parsed.decisions[0].url,'https://github.com/killbill2792/aicafe/pull/406');
});
test('status freshness reveals stale GitHub scheduler without claiming false live data',()=>{
 const now=Date.parse('2026-11-09T23:10:00Z');
 assert.equal(freshness('2026-11-09T23:05:00Z',now),'current');
 assert.equal(freshness('2026-11-09T22:30:00Z',now),'stale');
 assert.equal(freshness(null,now),'stale');
 assert.equal(statusLevel('repair_ci: queued (not sent)'),'warn');
 assert.equal(statusLevel('idle_continue: courier unconfirmed (queued; no receipt)'),'warn');
 assert.equal(statusLevel('superseded'),'neutral');
 assert.equal(statusLevel('clean'),'good');
});
test('public browser source only queries public issue comment and links out to private GitHub',()=>{
 assert.equal(PUBLIC_COMMENT_URL,
  'https://api.github.com/repos/killbill2792/aicafe/issues/comments/6752417190');
 assert.equal(PRIVATE_QUEUE_URL,
  'https://github.com/killbill2792/dave-task-queue/blob/main/dispatcher/owner-queue.md');
 assert.equal(REFRESH_INTERVAL_MS,120000);
});

test('failed public GitHub refresh visibly revokes healthy status rather than falsely claiming live',async()=>{
 const nodes=new Map([['#freshness',{className:'health current',textContent:'recent'}],
  ['#fetch-status',{textContent:'before'}]]);
 const old=globalThis.document;
 globalThis.document={querySelector:selector=>nodes.get(selector)};
 try {
  await refresh(async()=>({ok:false,status:429}));
  assert.equal(nodes.get('#freshness').className,'health stale');
  assert.match(nodes.get('#freshness').textContent,/Cannot verify/);
  assert.match(nodes.get('#fetch-status').textContent,/GitHub HTTP 429/);
 }finally {
  if(old===undefined)delete globalThis.document;
  else globalThis.document=old;
 }
});
