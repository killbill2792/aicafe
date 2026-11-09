// One public-safe view of the EXISTING private dispatcher ledger.
// GitHub remains the sole decision-maker; this is not an approval or task queue.
export const OWNER_VIEW_MARKER = '<!-- aicafe-dispatcher-owner-view:v1 -->';

const clean = value => String(value ?? '').replace(/https?:\/\/\S+/g, '[URL in GitHub source]')
  .replace(/[<>|\r\n]/g, ' ').replace(/@/g, '@ ').slice(0, 500).trim();
const prLink = (repo, n) => `[#${n}](https://github.com/${repo}/pull/${n})`;
const sourceLink = (rec, repo) => {
  const url = rec.github_owner_question_url;
  if (typeof url === 'string' &&
      url.startsWith(`https://github.com/${repo}/pull/${rec.pr_number}`) &&
      !/[\s<>()]/.test(url)) return url;
  return `https://github.com/${repo}/pull/${rec.pr_number}`;
};
const when = value => typeof value === 'string' && !Number.isNaN(Date.parse(value))
  ? new Date(value).toISOString() : 'unknown';

export function renderOwnerView(state, {repo, asOf, runUrl} = {}) {
  if (!state?.tasks || !state.actions || !/^[\w.-]+\/[\w.-]+$/.test(repo || ''))
    throw new Error('Invalid owner view state/repository');
  const now = when(asOf);
  const tasks = Object.entries(state.tasks).filter(([,r]) => Number.isInteger(r.pr_number))
    .sort(([,a],[,b]) => a.pr_number-b.pr_number);
  const actions = Object.entries(state.actions).map(([id,a])=>({id,...a}));
  const ownerNotice = Object.values(state.owner_alerts || {});
  const rows = tasks.map(([id,r]) => {
    const pending = actions.filter(a=>a.task_id===id &&
      ['planned','uncertain','claimed'].includes(a.status))
      .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0];
    const delivered = actions.filter(a=>a.task_id===id && a.status==='submitted')
      .sort((a,b)=>String(b.submitted_at||'').localeCompare(String(a.submitted_at||'')))[0];
    const muse = pending
      ? `${clean(pending.type)}: ${pending.status === 'planned' ? 'queued (not sent)' : pending.status}`
      : delivered ? `${clean(delivered.type)}: submitted (receipt recorded)` : 'no active delivery';
    const owner = r.github_owner_question || r.owner_question;
    const finished = r.github_state === 'merged' ||
      ['merged','integrated_proven','released_proven'].includes(r.status);
    const next = finished ? (r.status === 'merged'
        ? 'Dispatcher verifies merged-main integration proof' : 'Integrated; no coder action')
      : owner ? 'Owner decision + coder can continue signed work'
      : r.ci_state === 'failure' ? 'Coder fixes CI'
      : r.codex_state === 'findings' ? 'Coder resolves review findings'
      : r.draft ? 'Coder finishes draft/proof'
      : 'Dispatcher evaluates proof/merge gates';
    const stage = r.github_state === 'merged' || r.status === 'merged' ||
      ['integrated_proven','released_proven'].includes(r.status)
      ? r.status : r.draft ? 'Draft' : clean(r.status || 'Open');
    return `| ${clean(id)} | ${prLink(repo,r.pr_number)} | ${stage} | ${clean(r.ci_state || 'unknown')} | ${clean(r.codex_state || 'unknown')} | ${muse} | ${next} |`;
  });
  const outstanding = tasks.filter(([,r])=>Boolean(r.github_owner_question || r.owner_question))
    .map(([id,r])=>{
      const sent = ownerNotice.some(n=>n.task_id===id && n.kind==='owner_decision' &&
        n.status==='submitted' && n.pr_number===r.pr_number);
      return `- **${clean(id)} ${prLink(repo,r.pr_number)}:** ${clean(r.github_owner_question ||
        'Owner scope decision requested on this PR.')} [Open original GitHub question](${sourceLink(r,repo)}). Muse notification: **${sent ? 'delivered' : 'not yet confirmed'}**; owner approval: **still pending**.`;
    });
  const history = actions.sort((a,b)=>String(b.submitted_at||b.created_at||'')
    .localeCompare(String(a.submitted_at||a.created_at||''))).slice(0,12)
    .map(a=>`| ${clean(a.task_id)} | ${clean(a.type)} | ${clean(a.status)} | ${when(a.submitted_at || a.created_at)} |`);
  const planned = actions.filter(a=>a.status==='planned' && a.delivery_owner==='muse');
  const nextWake = planned.map(a=>Date.parse(a.last_wake_at||a.created_at||''))
    .filter(Number.isFinite).map(t=>t+900000);
  return [
    OWNER_VIEW_MARKER,
    '## AI CAFE — live owner control center',
    `**Last successful GitHub reconciliation shown:** ${now} (UTC)`,
    `**Private ledger as-of:** ${when(state.updated_at)}`,
    runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl)
      ? `[Open dispatcher execution](${runUrl})` : '',
    '',
    '### What is happening',
    '| Task | PR | Stage | CI | Codex | Muse | Next responsible party |',
    '|---|---|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | — | — | — | — | No tracked PR | — |']),
    '',
    '### Needs owner approval (no approvals inferred from alert delivery)',
    ...(outstanding.length ? outstanding : ['No current GitHub owner questions.']),
    '',
    '### Muse delivery and retries',
    '[Open authenticated private Muse queue](https://github.com/killbill2792/dave-task-queue/blob/main/dispatcher/owner-queue.md) — requires access to the private repository.',
    `**${planned.length}** planned Muse instruction(s); planned is not delivered.`,
    nextWake.length ? `Earliest planned-action recheck: **${new Date(Math.min(...nextWake)).toISOString()} UTC** (only when the existing GitHub workflow runs).`
      : 'No planned-action recheck.',
    '',
    '### Recent dispatcher history',
    '| Task | Action | Recorded status | Timestamp (UTC) |',
    '|---|---|---|---|',
    ...(history.length ? history : ['| — | — | — | — |']),
    '',
    '### How to act',
    'Reply to the **specific linked PR** with a precise owner decision. A ChatGPT or Muse message alone does not grant GitHub approval.',
    'The owner may comment **refresh status** on issue #411 to request another trusted-main check; this does not change approvals or send prompts.',
    'GitHub schedules are best-effort: an unchanged timestamp indicates there has been no subsequently successful reconciliation shown here.',
    '_Public-safe status only. Full prompts, private conversation URLs, hashes, credentials and receipts remain in the private ledger._',
  ].filter(Boolean).join('\n');
}

export async function publishOwnerView({github, issue, body}) {
  if (!Number.isSafeInteger(issue) || issue < 1 || !body.startsWith(OWNER_VIEW_MARKER))
    throw new Error('Invalid approved owner status destination');
  const existing = await github.request(`/issues/${issue}/comments?per_page=100`);
  if (!Array.isArray(existing) || existing.length >= 100)
    throw new Error('Owner view comment pagination not verified');
  const matches = existing.filter(c=>c.body?.startsWith(OWNER_VIEW_MARKER) &&
    c.user?.login === 'github-actions[bot]');
  if (matches.length > 1) throw new Error('Duplicate GitHub owner control center');
  if (matches.length && matches[0].body === body) return {status:'unchanged',id:matches[0].id};
  const result = matches.length
    ? await github.request(`/issues/comments/${matches[0].id}`,{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({body})})
    : await github.request(`/issues/${issue}/comments`,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({body})});
  return {status:matches.length?'updated':'created',id:result.id};
}
