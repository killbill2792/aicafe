import fs from 'node:fs';
import { parseChatUrl } from '../../scripts/dev-dispatcher/safety.mjs';

async function github(path, options = {}) {
  const response = await fetch('https://api.github.com' + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers
    }
  });
  if (!response.ok) throw new Error('GitHub API ' + response.status + ' ' + path);
  return response.status === 204 ? null : response.json();
}
function safe(s) { return String(s ?? '').replace(/[\r\n|]/g, ' ').slice(0, 500); }
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const exitCode = Number(process.env.LANDING_EXIT_CODE || 1);
  const result = exitCode === 0 ? 'PASS' : 'FAIL';
  const log = fs.existsSync(process.env.LANDING_LOG || '') ? fs.readFileSync(process.env.LANDING_LOG, 'utf8') : '';
  const tail = log.split(/\r?\n/).slice(-35).join('\n').slice(-5000);
  let pr = null;
  let chat = null;
  let lookupError = null;
  try {
    const prs = await github('/repos/' + repo + '/commits/' + sha + '/pulls?per_page=100');
    pr = prs.find(p => p.merged_at && p.base?.ref === 'main' && p.merge_commit_sha === sha)
      || prs.find(p => p.merged_at && p.base?.ref === 'main') || null;
    if (pr) {
      const detail = await github('/repos/' + repo + '/pulls/' + pr.number);
      chat = parseChatUrl(detail.body || '');
    }
  } catch (error) { lookupError = error.message; }
  const rows = [
    '## Landing check',
    '| Field | Value |', '| --- | --- |',
    '| Merged PR | ' + (pr ? '#' + pr.number : 'not found (direct push or unavailable)') + ' |',
    '| Merge SHA | ' + safe(sha) + ' |',
    '| Repo | ' + safe(repo) + ' |',
    '| Result | ' + result + ' |',
    '| Chat URL | ' + (chat || 'not supplied') + ' |'
  ];
  if (lookupError) rows.push('', 'PR lookup warning: ' + safe(lookupError));
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.join('\n') + '\n');
  if (exitCode !== 0 && pr) {
    const sentinel = '<!-- landing-check-failure sha:' + sha + ' -->';
    const path = '/repos/' + repo + '/issues/' + pr.number + '/comments';
    // Check all pages so a re-run cannot spam a busy PR.
    let alreadyPosted = false;
    for (let page = 1; page <= 20; page++) {
      const comments = await github(path + '?per_page=100&page=' + page);
      if (comments.some(c => (c.body || '').includes(sentinel))) { alreadyPosted = true; break; }
      if (comments.length < 100) break;
    }
    if (!alreadyPosted) {
      await github(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: sentinel + '\nLanding check failed on ' + sha + ' in ' + repo +
          (chat ? '\nChat: ' + chat : '') + '\n\nError tail:\n' + '~~~text\n' + tail.replace(/~~~/g, '---') + '\n~~~' })
      });
    }
  }
}
main().catch(e => {
  console.error('Landing receipt/reporting error:', e);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\nReceipt/reporting error: ' + String(e.message) + '\n');
  process.exitCode = 1;
});
