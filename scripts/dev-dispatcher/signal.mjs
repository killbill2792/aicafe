#!/usr/bin/env node
// Publish a privacy-preserving public wake-up hint. No prompt, task ID or private data.
import { createHmac } from 'node:crypto';
import { GitHubLedger } from './ledger.mjs';
import { pendingActions } from './bridge/bridge.mjs';

export function signalFor(state, secret) {
  if (!secret || secret.length < 32) throw new Error('Signal signing secret must be >= 32 characters');
  const ids = pendingActions(state).filter(a => a.delivery_owner === 'muse').map(a => a.key + ':' + a.delivery.prompt_hash).sort();
  return { version: 1, pending_count: ids.length,
    fingerprint: createHmac('sha256', secret).update(JSON.stringify(ids)).digest('hex') };
}

export async function publishSignal({ ledgerRepo, ledgerToken, publicRepo, publicToken, secret, branch = 'muse-signal', fetchFn = fetch }) {
  const ledger = new GitHubLedger({ repo: ledgerRepo, token: ledgerToken });
  await ledger.verifyPrivate();
  const state = (await ledger.load()).state;
  const signal = signalFor(state, secret);
  const url = `https://api.github.com/repos/${publicRepo}/contents/signal.json?ref=${encodeURIComponent(branch)}`;
  const headers = { Authorization: `Bearer ${publicToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const existing = await fetchFn(url, { headers });
  if (!existing.ok) throw new Error(`Public signal read failed: ${existing.status}`);
  const file = await existing.json();
  const previous = JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  if (previous.fingerprint === signal.fingerprint && previous.pending_count === signal.pending_count) return false;
  const updated = await fetchFn(`https://api.github.com/repos/${publicRepo}/contents/signal.json`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, sha: file.sha, message: 'Update approved delivery wake-up signal',
      content: Buffer.from(JSON.stringify(signal, null, 2) + '\n').toString('base64') })
  });
  if (!updated.ok) throw new Error(`Public signal write failed: ${updated.status}`);
  return true;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  publishSignal({ ledgerRepo: process.env.DISPATCH_LEDGER_REPO,
    ledgerToken: process.env.DISPATCH_LEDGER_TOKEN, publicRepo: process.env.GITHUB_REPOSITORY,
    publicToken: process.env.GITHUB_TOKEN, secret: process.env.DISPATCH_SIGNAL_SECRET })
    .then(changed => console.log(changed ? 'Wake-up signal updated' : 'Wake-up signal unchanged'))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
