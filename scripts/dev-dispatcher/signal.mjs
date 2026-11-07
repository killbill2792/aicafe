// Public, privacy-preserving wake signal for a personal Muse event hook.
// Only an opaque HMAC of currently eligible approved action IDs is published.
// The private task body, prompt, target chat URL, GitHub SHA and task IDs stay private.
import { createHmac } from 'node:crypto';
import { GitHubLedger } from './ledger.mjs';
import { pendingActions } from './bridge/bridge.mjs';

const SIGNAL_BRANCH = 'muse-signal';
const SIGNAL_PATH = 'signal.json';
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function makePublicSignal(state, signingSecret) {
  if (typeof signingSecret !== 'string' || !signingSecret) throw new Error('Signal key required');
  const ids = pendingActions(state).map(action => action.key).sort();
  return {
    version: 1,
    pending: ids.length > 0,
    fingerprint: ids.length
      ? createHmac('sha256', signingSecret).update(JSON.stringify(ids)).digest('hex')
      : null,
  };
}

export async function publishSignal({
  repository = process.env.GITHUB_REPOSITORY,
  githubToken = process.env.GITHUB_TOKEN,
  ledgerRepository = process.env.DISPATCH_LEDGER_REPO,
  ledgerToken = process.env.DISPATCH_LEDGER_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!REPO.test(repository || '') || !githubToken || !REPO.test(ledgerRepository || '') || !ledgerToken)
    throw new Error('Repository, GitHub token and private ledger credentials required');

  const ledger = new GitHubLedger({ repo: ledgerRepository, token: ledgerToken, fetchFn: fetchImpl });
  await ledger.verifyPrivate();
  const { state } = await ledger.load();
  const desired = JSON.stringify(makePublicSignal(state, ledgerToken), null, 2) + '\n';

  // The signal lives on an unprotected dedicated branch, not main. This avoids
  // committing to main on every pending-task change or bypassing branch reviews.
  const url = `https://api.github.com/repos/${repository}/contents/${SIGNAL_PATH}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const existingResponse = await fetchImpl(`${url}?ref=${SIGNAL_BRANCH}`, { headers });
  if (!existingResponse.ok) throw new Error(`Cannot read public signal: HTTP ${existingResponse.status}`);
  const existing = await existingResponse.json();
  if (!existing?.sha || !existing?.content) throw new Error('Public signal is not initialized');
  const current = Buffer.from(existing.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (current === desired) return { changed: false, signal: JSON.parse(desired) };

  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'chore(muse-signal): eligible queue action set changed',
      branch: SIGNAL_BRANCH,
      sha: existing.sha,
      content: Buffer.from(desired).toString('base64'),
    }),
  });
  if (!response.ok) throw new Error(`Cannot publish public signal: HTTP ${response.status}`);
  return { changed: true, signal: JSON.parse(desired) };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  publishSignal()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
