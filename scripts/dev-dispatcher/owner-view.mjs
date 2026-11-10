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


/**
 * Owner-facing read-only graph. Nodes are sourced from the ONE approved queue
 * and current GitHub ledger; this never records a decision or authorizes work.
 * Use a bounded number of nodes so an expanding roadmap cannot overflow an issue.
 */
export function renderApprovedTaskMap(state, queue, repo) {
  const parts = String(repo || '').split('/');
  if (!Array.isArray(queue?.tasks) || !Array.isArray(queue?.merged_code_only) ||
      parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) return [];
  const approved = queue.tasks.filter(t =>
    t?.architecture_approval?.approved === true && /^[a-zA-Z0-9_]+$/.test(String(t.id)));
  if (!approved.length) return [];
  const deps = new Set(approved.flatMap(t => Array.isArray(t.depends_on) ? t.depends_on : []));
  const historical = queue.merged_code_only.filter(t =>
    deps.has(t.id) && /^[a-zA-Z0-9_]+$/.test(String(t.id)));
  const nodes = [...historical, ...approved];
  if (nodes.length > 20) return [
    '### Approved work and dependencies',
    'More than 20 approved/dependent tasks are active; use the [canonical task queue](https://github.com/' +
       repo + '/blob/main/docs/plans/universal-supervisor-queue.json) and the live task table below.',
    ''
  ];
  const ids = new Set(nodes.map(t => t.id));
  const label = value => String(value ?? '').replace(/[^a-zA-Z0-9 _.:,-]/g, ' ')
    .replace(/ +/g, ' ').trim().slice(0, 64);
  const status = (task, record) => {
    if (record?.status === 'released_proven') return 'Released and proven';
    if (record?.status === 'integrated_proven') return 'Integrated and proven';
    if (record?.github_state === 'merged' || record?.status === 'merged') return 'Merged';
    if (Number.isInteger(record?.pr_number)) {
      if (record.github_owner_question || record.owner_question) return 'Needs owner decision';
      if (record.ci_state === 'failure') return 'CI failing';
      if (record.codex_state === 'findings') return 'Codex findings';
      return record.draft ? 'Draft PR' : 'Open PR';
    }
    return task.architecture_approval?.approved ? 'Approved, not started' : 'Historical prerequisite';
  };
  const chart = ['flowchart TD'];
  for (const t of nodes) {
    const r = state.tasks?.[t.id];
    const name = label(t.title || (t.id === '5' ? 'Durable run and step storage' : 'Task'));
    const line = label(status(t, r));
    chart.push('  T_' + t.id + '["' + label(t.id) + ' - ' + name +
      '<br/>' + (Number.isInteger(r?.pr_number) ? 'PR #' + r.pr_number + ' - ' : '') + line + '"]');
  }
  for (const task of approved) {
    for (const dep of Array.isArray(task.depends_on) ? task.depends_on : []) {
      if (ids.has(dep)) chart.push('  T_' + dep + ' --> T_' + task.id);
    }
  }
  const count = queue.tasks.filter(t => t.state === 'proposed').length;
  return [
    '### Approved architecture to implementation map',
    '**This map reflects the approved queue and last reconciled task status; it does not grant approval.** ' +
      'The [living blueprint](https://github.com/' + repo +
      '/blob/main/docs/plans/owner-living-blueprint.md) explains the decisions behind these tasks.',
    '',
    '\x60\x60\x60mermaid',
    ...chart,
    '\x60\x60\x60',
    '',
    count ? '**Later ideas:** ' + count + ' proposed task briefs are not approved to code.' : '',
    'Select the linked PR in the task table below for exact questions, CI, Codex and executed proof.',
    ''
  ].filter(Boolean);
}

export function renderOwnerView(state, {repo, asOf, runUrl, queue} = {}) {
  if (!state?.tasks || !state.actions || !/^[\w.-]+\/[\w.-]+$/.test(repo || ''))
    throw new Error('Invalid owner view state/repository');
  const now = when(asOf);
  const tasks = Object.entries(state.tasks).filter(([,r]) => Number.isInteger(r.pr_number))
    .sort(([,a],[,b]) => a.pr_number-b.pr_number);
  const actions = Object.entries(state.actions).map(([id,a])=>({id,...a}));
  const overdue = a => a.status==='planned' &&
    a.delivery_owner==='muse' && Number.isFinite(Date.parse(a.created_at||'')) &&
    Number.isFinite(Date.parse(now)) &&
    Date.parse(now)-Date.parse(a.created_at)>20*60_000;
  const actionStatus = a => a.status==='cancelled_stale_head' ? 'superseded' :
    overdue(a) ? 'courier unconfirmed' : a.status;
  const ownerNotice = Object.values(state.owner_alerts || {});
  const rows = tasks.map(([id,r]) => {
    const pending = actions.filter(a=>a.task_id===id &&
      ['planned','uncertain','claimed'].includes(a.status))
      .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0];
    const delivered = actions.filter(a=>a.task_id===id && a.status==='submitted')
      .sort((a,b)=>String(b.submitted_at||'').localeCompare(String(a.submitted_at||'')))[0];
    const receiptHold = Object.values(state.receipt_feedback||{})
      .find(f=>f.task_id===id&&f.status==='rejected');
    const muse = pending
      ? `${clean(pending.type)}: ${overdue(pending) ? 'courier unconfirmed (queued; no receipt)' :
        pending.status === 'planned' ? 'queued (not sent)' : pending.status}`
      : receiptHold ? 'receipt rejected; Muse re-authenticates original (no resend)'
      : delivered ? `${clean(delivered.type)}: submitted (receipt recorded)` : 'no active delivery';
    const owner = r.github_owner_question || r.owner_question;
    const finished = r.github_state === 'merged' ||
      ['merged','integrated_proven','released_proven'].includes(r.status);
    const next = finished ? (r.status === 'merged'
        ? 'Dispatcher verifies merged-main integration proof' : 'Integrated; no coder action')
      : owner ? 'Owner decision + coder can continue signed work'
      : receiptHold ? 'Muse repairs signed receipt; same original chat'
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
    .map(a=>`| ${clean(a.task_id)} | ${clean(a.type)} | ${clean(actionStatus(a))} | ${when(a.submitted_at || a.created_at)} |`);
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
    ...renderApprovedTaskMap(state,queue,repo),
    '### What is happening',
    '| Task | PR | Stage | CI | Codex | Muse | Next responsible party |',
    '|---|---|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | — | — | — | — | No tracked PR | — |']),
    '',
    '### Needs owner approval (no approvals inferred from alert delivery)',
    ...(outstanding.length ? outstanding : ['No current GitHub owner questions.']),
    '',
    '### Muse delivery and retries',
    `**${Object.values(state.receipt_feedback||{}).filter(f=>f.status==='rejected').length}** receipt-authentication hold(s): Muse must repair original evidence, never resend an unverified browser prompt.`,
    state.receipt_scan?.complete===false ? '**Courier receipt scan incomplete:** keep previous delivery holds until verified.' : '',
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
