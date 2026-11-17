import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { parseOwnerSnapshot, statusLevel, freshness,
  PUBLIC_COMMENT_URL, PUBLIC_SNAPSHOT_URL,
  REFRESH_INTERVAL_MS, refresh, ageLabel,sortOperations,acceptPublicOperationsSnapshot } from '../../docs/owner-dashboard.mjs';

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

test('public old dashboard is replaced with noninteractive retirement notice',()=>{
 const html=readFileSync(new URL('../../docs/index.html',import.meta.url),'utf8');
 assert.match(html,/Previous development dashboard retired/);
 assert.match(html,/Muse.*private/);
 assert.match(html,/github\.com\/killbill2792\/aicafe\/pulls/);
 assert.doesNotMatch(html,/owner-operations-snapshot|owner-dashboard\.mjs|<script|task-rows|api\.github\.com|DISPATCH_LEDGER_TOKEN/);
});
test('archived dashboard parser is retained only for audit, never loaded by the live page',()=>{
 const script=readFileSync(new URL('../../docs/owner-dashboard.mjs',import.meta.url),'utf8');
 assert.equal(PUBLIC_SNAPSHOT_URL,'./owner-operations-snapshot.json');
 assert.match(script,/owner-operations-snapshot\.json/);
 const html=readFileSync(new URL('../../docs/index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/owner-dashboard|owner-operations-snapshot/);
});
test('old Pages publisher only deploys static retirement notice and cannot read ledger',()=>{
 const yaml=readFileSync(new URL('../../.github/workflows/ai-cafe-encrypted-owner-pages.yml',import.meta.url),'utf8');
 assert.match(yaml,/Retired Owner Operations notice/);
 assert.match(yaml,/actions\/upload-pages-artifact/);
 assert.match(yaml,/cp docs\/index\.html/);
 assert.doesNotMatch(yaml,/workflow_run:|cron:|workflow_dispatch:|DISPATCH_LEDGER_TOKEN|public-owner-payload|owner-operations-snapshot|node scripts\/dev-dispatcher|secrets\./);
});
test('commit and Codex review age, sorting and unknown status remain accurate',()=>{
 const now=Date.parse('2026-11-12T10:00:00Z');
 assert.equal(ageLabel('2026-11-12T09:50:00Z',now),'10m ago');
 assert.equal(ageLabel('2026-11-12T07:30:00Z',now),'2h 30m ago');
 assert.equal(ageLabel(null,now),'age unknown');
 const rows=[
 {id:'Task9',coding:{last_commit_at:'2026-11-12T07:00:00Z'},codex:{reviewed_at:null},
  ci:{status:'GREEN'}},
 {id:'Task10',coding:{last_commit_at:'2026-11-12T09:00:00Z'},
  codex:{reviewed_at:'2026-11-12T08:20:00Z'},ci:{status:'FAILED'}}
 ];
 assert.deepEqual(sortOperations(rows,{by:'commit',order:'desc'}).map(r=>r.id),['Task10','Task9']);
 assert.deepEqual(sortOperations(rows,{by:'commit',order:'asc'}).map(r=>r.id),['Task9','Task10']);
 assert.deepEqual(sortOperations(rows,{by:'codex',order:'desc'}).map(r=>r.id),['Task10','Task9']);
 assert.deepEqual(sortOperations(rows,{by:'ci',order:'asc'}).map(r=>r.id),['Task10','Task9']);
 assert.throws(()=>acceptPublicOperationsSnapshot({version:2,tasks:[{id:'../bad'}]}),
   /Invalid published/);
});
