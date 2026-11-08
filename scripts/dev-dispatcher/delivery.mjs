import { createHash } from 'node:crypto';
export const promptHash = prompt => createHash('sha256').update(prompt).digest('hex');
// Approved plan metadata -> bounded, provider-neutral browser handoff.
// Generated ONLY on trusted main by the existing deterministic dispatcher.
const PROVIDERS = new Set(['chatgpt', 'claude']);
const ACTIONS = new Set(['assign', 'repair_ci', 'repair_review', 'continue_pr', 'pre_pr_reminder']);
const REPO = 'https://github.com/killbill2792/aicafe';

// Stable authorization identity. A changed task brief, scope, approval or dependency
// requires a new owner-reviewed assignment, never reuse an old browser envelope.
export function approvalSignature(task) {
  if (!task) return null;
  const fields = [task.id, task.state, task.architecture_approval, task.exclusive_files,
    task.depends_on, task.title, task.goal, task.brief, task.acceptance];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}


export function createDelivery({ task, record, action, actionId }) {
  if (!task || task.architecture_approval?.approved !== true ||
      !['architecture_approved', 'ready'].includes(task.state) ||
      !Array.isArray(task.exclusive_files) || !task.exclusive_files.length ||
      record?.approved !== true || !ACTIONS.has(action) || !PROVIDERS.has(record.agent))
    throw new Error('Task is not authorized for browser delivery');
  if (typeof actionId !== 'string' || !actionId || actionId.length > 400) throw new Error('Invalid action ID');
  const authorization = approvalSignature(task);
  if (record.approval_hash && record.approval_hash !== authorization)
    throw new Error('Task approval or scope changed');
  const isNew = action === 'assign';
  const url = record.conversation_ref || null;
  if (!isNew && !url) throw new Error('Follow-up requires a saved conversation URL');
  if (url && !validConversationUrl(record.agent, url)) throw new Error('Invalid destination URL');
  const project = { id: 'aicafe', name: 'AI CAFE' }; // this dispatcher plans only AI CAFE; bridge is project-neutral
  const taskBrief = task.brief?.split('#')[0];
  if (!/^docs\/plans\/[a-zA-Z0-9_./-]+\.md$/.test(taskBrief || '') || taskBrief.includes('..'))
    throw new Error('Invalid task brief');
  const selectedSkills = Array.isArray(task.skills)
    ? [...new Set(task.skills.filter(skill => typeof skill === 'string' && /^[a-z][a-z0-9-]*$/.test(skill)))]
    : [];
  const stacked = Boolean(record.prerequisite_pr && record.base_branch && record.base_branch !== 'main');
  const details = [
    'You own ONE approved AI CAFE task and ONE PR from its early draft through final review, merge and proven integration. Use the connected GitHub plugin and current GitHub evidence, not assumptions or old chat summaries.',
    'BEFORE EDITING: Read current main AGENTS.md (highest authority), PROGRESS.md (read-only status), docs/rules/skills.md, docs/plans/universal-supervisor-queue.json, docs/plans/universal-supervisor-agent-operations.md, docs/plans/universal-supervisor-delivery-queue-2026-11.md, the exact task brief, and binding docs/rules/* relevant to this task. Respect the POS0a architecture-approval and POS0f priority gates; a priority or open branch alone is not approval to write.',
    'MANDATORY SKILLS: Explicitly fetch and read .claude/skills/aicafe-pr-lifecycle/SKILL.md, .claude/skills/aicafe-dependency-check/SKILL.md and .claude/skills/aicafe-proof-gate/SKILL.md. Read other applicable SKILL.md files selected through docs/rules/skills.md. ChatGPT must load skills by path; Claude may auto-discover them but must still verify applicability.',
    `TASK-SPECIFIC SKILLS from the approved queue: ${JSON.stringify(selectedSkills)}. Check each skill against docs/rules/skills.md, explicitly read its .claude/skills/<skill>/SKILL.md if installed and applicable, and document any unavailable entry rather than inventing skill instructions.`,
    'SHARED PROGRESS OWNERSHIP: NEVER edit PROGRESS.md in this task PR, including to tick off or repeat a previously merged dependency. Only the single coordination owner updates PROGRESS.md separately on latest main AFTER actual merge/proof. Record your own proof, merge SHA and remaining gaps in this PR body/task record. Check live GitHub to determine predecessor status; never rewrite a shared checklist from a parallel branch.',
    `Task acceptance requirements (each must have executable evidence): ${JSON.stringify(task.acceptance || [])}`,
    `Dependency task IDs: ${JSON.stringify(task.depends_on || [])}. Prerequisite branch/PR must be integrated before completion.`,
    'PRIOR MERGED WORK (verify before editing): read the latest main task queue, its merged_code_only entries, PROGRESS.md and live GitHub PR history; identify all relevant prior merged PR numbers, actual merge commit SHAs, what paths/data/contracts each delivered and what remains missing. Inspect the code and actual consumer on current main, not just a merged badge or old screenshot. Check executed CI/acceptance/integration run IDs and artifacts; distinguish merged code from integrated_proven and production release. Record the relevant predecessor PRs, verified evidence and gaps in this PR body. Reuse existing paths; do not duplicate, overwrite or assume unfinished work complete.',
    'For an open predecessor, inspect its real branch/head, PR diff, current exports and tests before stacking; keep all other dependencies in the brief and do not mark their integration proved. Re-evaluate on main as dependencies merge and rerun final-head acceptance, CI and Codex.',
    `Your working branch: ${record.branch || ('feat/aicafe-task-' + task.id)}. Base branch: ${record.base_branch || 'main'}.`,
    `Base branch: ${record.base_branch || 'main'}. ${record.prerequisite_pr ? `Predecessor PR: ${record.prerequisite_pr}.` : ''}`,
    'Include a per-acceptance executable test/evidence matrix in the PR; a checklist, merged label, green build or skipped test alone is not proof. For applicable prior merged PRs, re-run their relevant acceptance test on this branch if safely executable; cite exact current-head CI/integration runs and report missing evidence explicitly.',
    'OPEN THE DRAFT PR PROMPTLY after confirming authorization, correct branch/base and exclusive scope. Implementation and tests continue AFTER the draft is opened. Put exactly one <!-- aicafe-acceptance-evidence {JSON} --> comment in the PR body, with task_id, head_sha, base_sha and acceptance rows in approved order (id, test_file, command, result=passed). Only use node --test <test_file> or npx vitest run <test_file> as exact executable commands. The separate AI CAFE Acceptance Evidence workflow runs these tests from the exact PR head using its runner from trusted main, with no shell evaluation of your inputs. After CI succeeds, update the same comment with ci_run_id (the baseline run), acceptance_run_id (the execution-proof workflow run) and its actual acceptance job_url for every row. Evidence from a previous head/base or a skipped job is not proof. GitHub verifies the run and the matching execution artifact before merge.',
    `Include exactly one <!-- aicafe-task-id ${task.id} --> marker in the PR description so manually opened PRs can be linked without guessing.`,
    stacked
      ? `DEPENDENT TASK: OPEN A DRAFT PR PROMPTLY on the existing prerequisite branch ${record.base_branch} (PR #${record.prerequisite_pr}) as its PR base, NOT main. Do not wait for that dependency to merge; code and test the authorized scope against its current committed implementation while other upstream PRs also progress. Do not invent an absent interface. Other dependencies remain merge blockers. Once predecessors are actually merged and integrated-proven, retarget/rebase this same PR onto latest main, rerun acceptance/CI and final-head Codex, then merge under AGENTS.md.`
      : 'INDEPENDENT TASK: OPEN A DRAFT PR PROMPTLY against current main; do not wait to finish implementation, acceptance or review before creating the PR. Keep working in that SAME draft until the checks and final Codex are complete.',
    'CODEX LIFECYCLE: Opening a draft PR may trigger an early review, but an early clean review of incomplete work NEVER proves the final head clean. Request/review Codex after meaningful implementation; inspect the actual submitted full initial review, current-head findings and unresolved threads; fix all required findings, resolve addressed threads and request a fresh Codex review. Repeat for substantive changes/rebases until the final applicable head is reviewed clean. Do not request paid/redundant reviews on every tiny commit. A pending review is PENDING, not CLEAN.',
    'Stay in this SAME coding conversation and PR during active execution while CI and Codex are running: check their real conclusions, repair failures, obtain final-head review, resolve conflicts/reviews and finish under AGENTS.md. DO NOT create a background monitoring loop, cron or separate watcher; if your current execution ends, the coordinator resumes THIS SAME conversation from the recorded GitHub head. Never open a replacement chat.',
    'OWNER DECISION: If any architecture, file ownership, secret or consequential action needs owner approval, promptly publish the precise question on this same draft PR, add the needs-owner-decision label and exactly one <!-- aicafe-owner-question your concise question --> marker in the PR body. Leave the PR open and STOP only the unapproved part; do not silently wait or invent approval. Remove/resolve the blocker only after a verifiable owner decision.',
    'CI AND COSTS: Use the existing GitHub Actions jobs and disposable test resources. NEVER create or enable Vercel preview deployments/builds. Targeted browser/Playwright acceptance belongs in GitHub CI when required; E2 remains separately gated and proposed. A local Next.js CI build is not a Vercel deployment.',
    `Task ${task.id}: ${task.title}`,
    `Goal: ${task.goal}`,
    `Approved file ownership: ${task.exclusive_files.join(', ')}`,
    `Task brief: ${REPO}/blob/main/${task.brief}`,
    `Read ${REPO}/blob/main/AGENTS.md and PROGRESS.md before coding.`,
    'Work in the SAME PR and conversation for follow-ups. Mark draft ready and merge only after latest-head executed acceptance, CI, Codex clean/threads resolved, dependencies integrated, up-to-date base and approved ownership are verified. Record exact merge SHA and later integration proof separately.',
    'Do not claim that a merge proves integration or production release.',
  ];
  if (/^POS0[a-f]$/.test(task.id)) details.splice(2, 0,
    'POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING — READ IN ORDER: (1) current main AGENTS.md (PROGRESS.md read-only); (2) binding docs/rules/pos-data.md; (3) docs/plans/toast-standard-api-coverage-matrix.md # Start here: approved D1–D4A/D4B decisions and defects; (4) THIS exact docs/plans/universal-supervisor-task-briefs.md task anchor AND docs/plans/universal-supervisor-queue.json with architecture_foundation_implementation_approval.approved=false; (5) inspect real existing code, active deployed SQL, writers/readers and consumers; (6) docs/rules/tests.md executable acceptance with CI and rollback. PR #398 is draft: read its actual head for review while not on main; STOP implementation at owner gate. Old Toast runbooks/migrations are history, not instructions. toast_raw_records=OPERATIONAL_CURRENT, toast_raw_changes=OPERATIONAL_CHANGE_LOG; toast_raw_samples and toast_raw_samples_latest=LEGACY_DIAGNOSTIC_ONLY; Test Café mirrors=TEST_FIXTURE_ONLY. CURRENT DEFECTS: non-order toast_records_for and cv_cash/cv_inventory/cv_kitchen/cv_dining_options use diagnostic snapshots; dictionary still says daily capture; seen_run_id live; SQL day import can roll back good rows on DB failure; liveArchive.server.ts skips pages after failed archive; menu full fetch twice/unsafe retirement; labor wage-status mismatch. Preserve current per-order parser, durable pages/checkpoints, revisions, owner edits, existing screen/Supervisor math until D3 parity, performance, tenant and rollback proof. OWNERS: POS0e current reader/dictionary, POS0b labor, POS0c cash/stock/kitchen, POS0d menu/config, POS0f final lineage/parity; SQL order recovery has NO separately owner-approved implementation PR/files. D1-D4A/D4B PRINCIPLES approved only: D4A Approach B = per-family changed/version checks, validated bounded snapshots, automatic reconciliation in EXISTING 10-minute coordinator plus SEPARATE 15-minute live-order collection; never full GET each tick or webhook-only. D4B lossless SQL outcome: 99 good plus one DB-failing order must leave 99 independently queryable/durable; only affected metrics partial with source/as-of, NOT global day shutdown; unverified day total remains uncertified. Known-order sums are not final/minima/estimates (negative refunds); preserve last verified as-of. D4B approved order identity: processing stages received/raw_saved/parsed_validated/canonical_promoted/metric_reconciled attach logically to scoped cafe+restaurant+Toast order GUID; leave source JSON and toast_raw_changes free of app flags; NO existing status column or schema claimed. Existing 15-minute full current-day ordersBulk retries eligible FINISHED orders idempotently, not open orders. A no-GUID or failed row/page write has no order-row flag: preserve staging/toast_unparsed_orders/day-status evidence. Clear issues ONLY after durable save, validation and reconciliation proof, not live-summary/download. Recover using existing bounded repulls after rollover; separate SQL-row, entire DB outage, 429/auth and permanent defects without hot loops. Preserve #189 nonce/cursor/429/generation-bound cost ACK; #203 backfill-first/shared five-day fairness; #264 timeout/payment-gap progress; #297 five-date/1h-to-24h dedup. 77 due cost jobs are separate; toast_ack_rollup_refresh returning false is not success. Exact B1 SQL and recovery scheduling UNAPPROVED. POS0-order-recovery is NON-DISPATCHABLE until separate owner SQL/file approval. No new system, cron, worker, queue, archive or competing AI reader. PR must state source_authority_checked: yes and prove source→current object→describe_data→query_data→real Supervisor/screen plus negative diagnostic contamination. Runtime implementation and #398/#400 merge NOT approved.');
  if (record.pr_number) details.push(`Associated PR: ${REPO}/pull/${record.pr_number}`);
  if (!isNew) details.push(`REQUIRED NEXT ACTION: ${action}. Continue from where you left off in THIS SAME chat, branch and draft/PR; do not restart or duplicate completed work. Last GitHub-observed commit: ${record.head_sha || 'none'}. Branch: ${record.branch || 'unknown'}. PR: ${record.pr_number ? REPO + '/pull/' + record.pr_number : 'not opened; open a draft promptly'}. CI: ${record.ci_state || 'unknown'}. Codex: ${record.codex_state || 'unknown'}. Base current: ${record.base_current !== false}. Base changed review required: ${record.review_base_current === false}. If PR is missing, open its draft now. Check actual GitHub head, checks, review comments and remaining acceptance evidence; address findings; re-request final-head Codex review and finish or publish the precise owner blocker. If branch update conflicts, resolve only in the existing coding PR; re-run relevant CI and Codex. Fix only unfinished items.`);
  const prompt = details.join('\n');
  if (prompt.length > 12000) throw new Error('Browser prompt too long');
  return {
    version: 1, action_id: actionId, project, approval_hash: authorization,
    provider: record.agent,
    intent: isNew ? 'start_new_chat' : 'continue_existing_chat',
    base_branch: record.base_branch || 'main',
    conversation_url: url,
    task_id: task.id,
    prompt, prompt_hash: promptHash(prompt),
  };
}

export function validConversationUrl(provider, value) {
  if (!PROVIDERS.has(provider) || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
    if (provider === 'chatgpt') return url.host === 'chatgpt.com' && /^\/(?:c|g\/[a-zA-Z0-9_-]+\/c)\/[a-zA-Z0-9-]+\/?$/.test(url.pathname);
    return url.host === 'claude.ai' && /^\/chat\/[a-zA-Z0-9-]+\/?$/.test(url.pathname);
  } catch { return false; }
}
