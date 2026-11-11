#!/usr/bin/env node
import {settings} from './settings.mjs';
// Publish a privacy-preserving public wake-up hint. No prompt, task ID or private data.
import { createHmac } from 'node:crypto';
import { GitHubLedger } from './ledger.mjs';
import { pendingActions } from './bridge/bridge.mjs';
import { noticeHash } from './alerts.mjs';
import {reportMuseSignalFailure,reportMuseSignalRestored} from './notifications.mjs';
import {dispatchReceiptWake} from './wake.mjs';

export function signalFor(state, secret) {
  if (!secret || secret.length < 32) throw new Error('Signal signing secret must be >= 32 characters');
  const deliveries = pendingActions(state).filter(a => a.delivery_owner === 'muse').map(a => a.key + ':' + a.delivery.prompt_hash + ':' + (a.wake_round || 0));
  const notices = Object.entries(state.owner_alerts || {}).filter(([key,a]) =>
    a.status === 'planned' && a.delivery_owner === 'muse' &&
    (a.notice_hash === noticeHash(a) ||
      // Historic operational alerts were keyed by their identity hash but
      // did not persist that identity field. Keep them deliverable after upgrade.
      (key === 'notice:' + a.notice_hash && /^[a-f0-9]{64}$/.test(a.notice_hash||''))))
    .map(([key,a]) => 'owner:' + key + ':' + a.notice_hash + ':' + (a.wake_round || 0));
  // Opaque repair hint: same courier, same receipt; NEVER a new browser send.
  const repairs = Object.entries(state.receipt_feedback || {})
    .filter(([,f]) => f.status === 'rejected')
    .map(([id,f]) => 'receipt:' + id + ':' + f.code + ':' + (f.wake_round || 0));
  const ids = [...deliveries, ...notices, ...repairs].sort();
  return { version: 1, pending_count: ids.length,
    fingerprint: createHmac('sha256', secret).update(JSON.stringify(ids)).digest('hex') };
}

export async function publishSignal({ ledgerRepo, ledgerToken, publicRepo, publicToken, secret, branch = 'muse-signal', fetchFn = fetch }) {
  const ledger = new GitHubLedger({ repo: ledgerRepo, token: ledgerToken, path:settings.ledger.path });
  await ledger.verifyPrivate();
  const state = (await ledger.load()).state;
  const signal = signalFor(state, secret);
  const url = `https://api.github.com/repos/${publicRepo}/contents/${settings.paths.signal}?ref=${encodeURIComponent(branch)}`;
  const headers = { Authorization: `Bearer ${publicToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const existing = await fetchFn(url, { headers });
  if (!existing.ok) throw new Error(`Public signal read failed: ${existing.status}`);
  const file = await existing.json();
  const previous = JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  if (previous.fingerprint === signal.fingerprint && previous.pending_count === signal.pending_count) return false;
  const updated = await fetchFn(`https://api.github.com/repos/${publicRepo}/contents/${settings.paths.signal}`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, sha: file.sha, message: 'Update approved delivery wake-up signal',
      content: Buffer.from(JSON.stringify(signal, null, 2) + '\n').toString('base64') })
  });
  if (!updated.ok) throw new Error(`Public signal write failed: ${updated.status}`);
  return true;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const repo=process.env.GITHUB_REPOSITORY || settings.repo;
  const ledgerRepo=process.env.DISPATCH_LEDGER_REPO || settings.ledger.repo;
  const args={ledgerRepo,ledgerToken:process.env.DISPATCH_LEDGER_TOKEN,
    publicRepo:repo,publicToken:process.env.GITHUB_TOKEN,
    secret:process.env.DISPATCH_SIGNAL_SECRET};
  const ledger=()=>new GitHubLedger({repo:ledgerRepo,token:args.ledgerToken,
    path:settings.ledger.path});
  let phase='publish';
  (async()=>{
    const changed=await publishSignal(args);
    // Do not misreport a later ledger read failure as an outbound signal
    // failure. The first signal has already been independently published.
    phase='recovery_record';
    if(args.ledgerToken){
      const recovered=await reportMuseSignalRestored({ledger:ledger(),repo});
      if(recovered.committed){
        phase='closure_publish';
        await publishSignal(args);
      }
    }
    console.log(changed ? 'Wake-up signal updated' : 'Wake-up signal unchanged');
  })().catch(async e=>{
    console.error('Muse '+phase+' failed: '+String(e.message).slice(0,180));
    if(phase!=='recovery_record'&&args.ledgerToken)try{
      await reportMuseSignalFailure({ledger:ledger(),repo,
        message:String(e.message),wake:()=>dispatchReceiptWake({token:args.publicToken})});
    }catch(second){
      console.error('Muse signal failure alert unavailable: '+String(second.message).slice(0,120));
    }
    process.exitCode=1;
  });
}
