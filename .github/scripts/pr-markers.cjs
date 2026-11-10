'use strict';

const REPO_MARKER = /<!--\s*repo:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+task:\s*([^\s>]+)\s*-->/g;
const CHAT_MARKER = /<!--\s*aicafe-chat-url\s+(https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9_-]+|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+))\s*-->/;

function parseRepoMarker(body = '') {
  const matches = [...body.matchAll(REPO_MARKER)];
  if (!matches.length) return null;
  return { repo: matches[0][1], task: matches[0][2], ambiguous: matches.some(m => m[1] !== matches[0][1]) };
}

function parseChatUrl(body = '') {
  return body.match(CHAT_MARKER)?.[1] || null;
}

function validateRepo(body, actualRepo) {
  const marker = parseRepoMarker(body);
  if (!marker) return { status: 'warning', message: 'No <!-- repo: owner/name task: id --> marker; warning only.' };
  if (marker.ambiguous) return { status: 'failure', message: 'Conflicting repository markers in PR body.' };
  if (marker.repo.toLowerCase() !== actualRepo.toLowerCase()) {
    return { status: 'failure', message: 'This PR says it belongs to ' + marker.repo + ' but is in ' + actualRepo };
  }
  return { status: 'success', message: 'PR repository matches ' + actualRepo + ' (task ' + marker.task + ').' };
}

module.exports = { parseRepoMarker, parseChatUrl, validateRepo };

if (require.main === module) {
  const result = validateRepo(process.env.PR_BODY || '', process.env.GITHUB_REPOSITORY || '');
  if (result.status === 'warning') console.log('::warning::' + result.message);
  else if (result.status === 'failure') console.error('::error::' + result.message);
  else console.log(result.message);
  process.exitCode = result.status === 'failure' ? 1 : 0;
}
