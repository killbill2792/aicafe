import { createHash } from 'node:crypto';
import { editableFiles, usedFiles } from './core.mjs';
export const promptHash = prompt => createHash('sha256').update(prompt).digest('hex');
// Approved plan metadata -> bounded, provider-neutral browser handoff.
// Generated ONLY on trusted main by the existing deterministic dispatcher.
const PROVIDERS = new Set(['chatgpt', 'claude']);
const ACTIONS = new Set(['assign', 'repair_ci', 'repair_review', 'continue_pr', 'pre_pr_reminder',
  'codex_comments', 'ci_failed', 'parent_merged', 'owner_answered', 'idle_continue']);
const V2_NUDGES = new Set(['codex_comments','ci_failed','parent_merged','owner_answered','idle_continue']);
const REPO = 'https://github.com/killbill2792/aicafe';

// Stable authorization identity. A changed task brief, scope, approval or dependency
// requires a new owner-reviewed assignment, never reuse an old browser envelope.
export function approvalSignature(task) {
  if (!task) return null;
  const fields = [task.id, task.state, task.architecture_approval, task.exclusive_files,
    task.depends_on, task.title, task.goal, task.brief, task.acceptance];
  // Do not invalidate signatures of already-planned, owner-signed legacy tasks.
  if (Object.hasOwn(task,'edits') || Object.hasOwn(task,'uses'))
    fields.push(task.edits,task.uses);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}


export function createDelivery({ task, record, action, actionId }) {
  if (!task || task.architecture_approval?.approved !== true ||
      !['architecture_approved', 'ready'].includes(task.state) ||
      !Array.isArray(editableFiles(task)) || !editableFiles(task).length ||
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
  if (V2_NUDGES.has(action)) {
    const pr = record.pr_number ? REPO + '/pull/' + record.pr_number : 'the existing PR';
    const head = record.head_sha || 'unverified';
    const comments = (record.unresolved_codex_comments || []).slice(0,4)
      .map(c => '- ' + String(c.body || 'Unresolved review thread').replace(/\s+/g,' ').slice(0,180) +
        (c.url && /^https:\/\/github\.com\//.test(c.url) ? ' ' + c.url : '')).join('\n');
    const byReason = {
      codex_comments: 'Codex comments: ' + (comments || 'Read unresolved inline comments on ' + pr) +
        '\nFix the actual findings together; rerun CI before one exact-head re-review.',
      ci_failed: 'CI failed: ' + (record.ci_failure_job || 'check the failing job') +
        (record.ci_failure_url ? ' ' + record.ci_failure_url : ' (' + pr + ')') +
        '. Diagnose the failing test/job and fix it without weakening assertions. Rerun CI.',
      parent_merged: 'Parent PR merged (' + (record.parent_merged_sha || 'verify merge SHA') +
        '). Rebase onto main and continue in this same child PR. Rerun CI and acceptance on the new base. Do not request Codex until the final main-based head is green.',
      owner_answered: 'Owner answered: ' + String(record.owner_answer_text || 'Read the signed answer on ' + pr).slice(0,350) +
        '\nApply only the answer within approved file scope; update PR comment dispositions and rerun applicable CI.',
      idle_continue: 'Continue the same PR and branch. Check the latest GitHub state, finish the approved code/CI/acceptance and reconcile comments. When green and complete, mark coder done in the PR; ready state triggers Codex once, not on intermediate pushes.'
    };
    const prompt = 'Task ' + task.id + ', PR ' + pr + ', head ' + head + '.\n' +
      byReason[action] + '\nDo not expand approved edits or bypass owner/merge gates.';
    if (prompt.trim().split(/\s+/).length >= 120) throw new Error('Nudge exceeds 120 words');
    return {version:1,action_id:actionId,project,approval_hash:authorization,
      provider:record.agent,intent:'continue_existing_chat',
      base_branch:record.base_branch || 'main',conversation_url:url,
      task_id:task.id,prompt,prompt_hash:promptHash(prompt)};
  }
  const taskBrief = task.brief?.split('#')[0];
  if (!/^docs\/plans\/[a-zA-Z0-9_./-]+\.md$/.test(taskBrief || '') || taskBrief.includes('..'))
    throw new Error('Invalid task brief');
  const selectedSkills = Array.isArray(task.skills)
    ? [...new Set(task.skills.filter(skill => typeof skill === 'string' && /^[a-z][a-z0-9-]*$/.test(skill)))]
    : [];
  const stacked = Boolean(record.prerequisite_pr && record.base_branch && record.base_branch !== 'main');
  const details = [
    'Own ONE approved AI CAFE task and ONE PR from early draft through verified integration. Use connected GitHub and current evidence, not old chat assumptions.',
    'BEFORE EDITING: current main AGENTS.md (highest), PROGRESS.md (read-only), docs/rules/skills.md, task brief and docs/plans/universal-supervisor-queue.json; relevant binding docs/rules/* and applicable skills. docs/plans/universal-supervisor-agent-operations.md and docs/plans/universal-supervisor-delivery-queue-2026-11.md are lifecycle/context, NOT new approval paths. No priority/PR implies authorization.',
    'MANDATORY SKILLS: Explicitly fetch and read .claude/skills/aicafe-pr-lifecycle/SKILL.md, .claude/skills/aicafe-dependency-check/SKILL.md and .claude/skills/aicafe-proof-gate/SKILL.md. Read other applicable SKILL.md files selected through docs/rules/skills.md. ChatGPT must load skills by path; Claude may auto-discover them but must still verify applicability.',
    `TASK-SPECIFIC SKILLS from the approved queue: ${JSON.stringify(selectedSkills)}. Check each skill against docs/rules/skills.md, explicitly read its .claude/skills/<skill>/SKILL.md if installed and applicable, and document any unavailable entry rather than inventing skill instructions.`,
    'SHARED PROGRESS OWNERSHIP: NEVER edit PROGRESS.md in this task PR. Only the coordinator updates it on main after verified merge/proof. Record task evidence, merge SHA and gaps in your PR. Check live predecessors; do not rewrite shared progress from a task branch.',
    `TASK ACCEPTANCE (signed): Read EVERY task.acceptance entry for ${task.id} in docs/plans/universal-supervisor-queue.json and its exact task brief; include and execute each required scenario in the PR evidence matrix. The full array stays in approvalSignature and is not pasted into this handoff.`,
    `Dependency task IDs: ${JSON.stringify(task.depends_on || [])}. Prerequisite branch/PR must be integrated before completion.`,
    'PRIOR MERGED WORK: Check main queue, PROGRESS, live GitHub, actual merge commit SHAs, existing paths/consumers and executed CI/acceptance/integration run IDs and artifacts. Merged code is not integrated_proven or production release. List other dependencies and proof gaps; do not duplicate work.',
    'For open predecessors, verify branch/head, diff, exports and tests; recheck main, other blockers and final-head CI/Codex.',
    `Your working branch: ${record.branch || ('feat/aicafe-task-' + task.id)}. Base branch: ${record.base_branch || 'main'}.`,
    `Base branch: ${record.base_branch || 'main'}. ${record.prerequisite_pr ? `Predecessor PR: ${record.prerequisite_pr}.` : ''}`,
    'Include a per-acceptance executable evidence matrix. A checklist, green/merged status or skipped job is not proof. Re-run relevant predecessor tests when safe; cite exact current-head CI/integration runs and gaps.',
    'OPEN THE DRAFT PR PROMPTLY after confirming authorization, correct branch/base and exclusive scope. Implementation and tests continue AFTER the draft is opened. Put exactly one <!-- aicafe-acceptance-evidence {JSON} --> comment in the PR body, with task_id, head_sha, base_sha and acceptance rows in approved order (id, test_file, command, result=passed). Only use node --test <test_file> or npx vitest run <test_file> as exact executable commands. The separate AI CAFE Acceptance Evidence workflow runs these tests from the exact PR head using its runner from trusted main, with no shell evaluation of your inputs. After CI succeeds, update the same comment with ci_run_id (the baseline run), acceptance_run_id (the execution-proof workflow run) and its actual acceptance job_url for every row. Evidence from a previous head/base or a skipped job is not proof. GitHub verifies the run and the matching execution artifact before merge.',
    `Include exactly one <!-- aicafe-task-id ${task.id} --> marker in the PR description so manually opened PRs can be linked without guessing.`,
    stacked
       ? `DEPENDENT TASK: OPEN A DRAFT PR PROMPTLY on prerequisite branch ${record.base_branch} (PR #${record.prerequisite_pr}), NOT main. Do not wait for the parent to merge before approved code/tests; keep the same stacked draft. Other dependencies remain merge blockers. After the parent merges, retarget onto main, rerun CI/acceptance, and request Codex ONCE on the final CI-green head; never while parent moves.`
       : 'INDEPENDENT TASK: OPEN A DRAFT PR PROMPTLY against current main; keep working in this SAME draft. Finish code/CI, then request ONE ready-state Codex review. No extra @codex if GitHub started it.',
    'READY SIGNAL: When implementation, applicable tests and actual CI are done, add exactly one <!-- aicafe-coder-done --> marker to the existing PR description. The dispatcher observes this GitHub-visible completion signal; a chat statement alone is not observable from GitHub. Keep dependent drafts coding/CI while parents are open; they become ready only after main rebase and all proof gates.',
    'CODEX LIFECYCLE: Draft/stacked-parent-moving/CI-pending means NO Codex request. Finish code, docs and owner decisions first. With full CI GREEN on current-main final head, mark ready and request ONE review; if ready triggered Codex, do not @codex again. No review for comments or same head. Batch substantive fixes, rerun CI, then request ONE final-head re-review. Exact-head, threads and acceptance gates stay mandatory.',
    'COMMENT ACCOUNTABILITY: Fetch ALL owner/agent PR conversation comments and inline review threads, including comments newer than the latest commit. In this SAME PR description update one Comment disposition checklist keyed by exact GitHub comment/thread IDs: acknowledged, working, blocked-owner, fixed-awaiting-proof, verified or superseded; include owning file/task and commit+executed CI/test or blocker. Reconcile every actionable ID before edits and before reporting done. A reply, checkmark, Codex clean or resolved thread alone is not verification; never silently discard a newer decision. No parallel queue.',
    'Stay in this SAME PR/chat through proof. Fix CI/Codex in place under AGENTS.md. DO NOT create a background monitoring loop, cron or separate watcher; coordinator resumes THIS SAME chat at saved GitHub head. Never open a replacement chat.',
    'OWNER DECISION: For unapproved architecture, files, secrets or consequential actions, ask precisely in the SAME PR, label needs-owner-decision, add ONE <!-- aicafe-owner-question your concise question --> marker, and stop only that part. Never invent approval. Remove/resolve the blocker only after a verifiable owner decision.',
    'CI AND COSTS: Use the existing GitHub Actions jobs and disposable test resources. NEVER create or enable Vercel preview deployments/builds. Targeted browser/Playwright acceptance belongs in GitHub CI when required; E2 remains separately gated and proposed. A local Next.js CI build is not a Vercel deployment.',
    `Task ${task.id}: ${task.title}`,
    `Goal: ${task.goal}`,
    `Approved file ownership: ${editableFiles(task).length > 8 ? `${editableFiles(task).length} EXACT signed edit paths: read task ${task.id}.edits (or signed legacy exclusive_files) in the current approved queue, and edit ONLY those paths. Other tasks' files in uses may be imported READ-ONLY. Full list is covered by approvalSignature.` : editableFiles(task).join(', ')}`,
    `Read-only shared uses (may import; NEVER edit): ${JSON.stringify(usedFiles(task))}`,
    `Task brief: ${REPO}/blob/main/${task.brief}`,
    `Read ${REPO}/blob/main/AGENTS.md and PROGRESS.md before coding.`,
    'SAME PR/chat for follow-ups. Mark ready/merge only after latest-head executed acceptance, CI, Codex clean/threads resolved, integrated dependencies, current base and approved file ownership. Record merge SHA and separate integration proof.',
    'Do not claim that a merge proves integration or production release.',
  ];
  if (/^POS0[a-f]$/.test(task.id)) details.splice(2, 0,
    "POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING — READ IN ORDER: (1) current main AGENTS.md; PROGRESS read-only; (2) binding docs/rules/pos-data.md; (3) #398 POS0a handoff card FIRST; targeted docs/plans/toast-standard-api-coverage-matrix.md evidence only; (4) THIS exact docs/plans/universal-supervisor-task-briefs.md task anchor AND docs/plans/universal-supervisor-queue.json; architecture_foundation_implementation_approval.approved (false means STOP); own task coding approval mandatory (tracking != activation); (5) inspect real existing code/SQL/readers; (6) docs/rules/tests.md executable acceptance/rollback. PRs #398/#399/#400 merged; POS0a is DOCUMENTATION-ONLY (owner-accepted merge, no runtime integrated_proven). POS0e-f coding still requires each task's explicit file-scope owner approval. D1-D4A/D4B/D4C PRINCIPLES approved only; NO runtime/merge; source_authority_checked: yes. toast_raw_records=current; toast_raw_changes=delta; toast_raw_samples=LEGACY_DIAGNOSTIC_ONLY; diagnostic snapshots/Test Café not live; diagnostic-only values never influence live results; describe_data/query_data shared. DEFECTS: non-order toast_records_for, cv_cash/cv_inventory/cv_kitchen/cv_dining_options diagnostic; dictionary daily capture wrong; seen_run_id live; SQL day import rollback; liveArchive.server.ts page loss; menu full fetch twice; wage gap. POS0a=read-only official field/GAP map; POS0e/f=FUTURE reader/agent proof. POS0e reader, POS0b labor, POS0c cash/stock/kitchen, POS0d menu, POS0f final. D4A Approach B: 10-minute coordinator + 15-minute live-order; change-driven menu. D4B lossless SQL: Approach 1 REPAIR existing day-import/liveArchive, no second importer; 99 good plus one DB-failing order queryable, totals partial. processing stages received/raw_saved/parsed_validated/canonical_promoted/metric_reconciled scoped cafe+restaurant+Toast order GUID; NO existing status column; Toast JSON unchanged. full current-day ordersBulk retries; no-GUID or failed row/page write uses staged retry. Clear issues ONLY after durable save/reconciliation. POS0-order-recovery: NO separately owner-approved implementation PR; preserve #189 #203 #264 #297. D4C menu lifecycle: confirmed absent => provider INACTIVE; same GUID republish; Empty/partial/wrong-version/unauthorized/missing-reference/zero-sales cannot deactivate. MENU/EXPERIMENT SPEC HANDOFF: #398 specs/0001-d4c-toast-menu-authority-and-owner-review.md and specs/0002-pos-change-verified-experiment-activation.md IN REVIEW. Toast-first connected catalog: ONE complete authenticated current Toast size GUIDs/prices/status; costs verified or missing. NO local Add Item/draft or legacy Owner review tab; test rows never leak into live catalog (D3 retain); Toast Web publishes; AI CAFE edits linked recipes/cost only; non-Toast manual kept. Option A auto-link only proven cafe+product+size; 563 historic sales valid, COGS unknown; historical Option B APPROVED; SQL/design remains OPEN. manual_done not publication; source-verified target starts experiment; pending ~+2h/next morning MAX TWO per cafe-local day; rolling 24h + final cafe-close extension. Proactive source-verified Toast price DELTA (cafe/item/size/context) => ONE Supervisor notice + 7-day OBSERVATIONAL watch (NO experiment), DAILY day1–7 updates + final; as-of, reverts, partial COGS, dedup, no causal claims. Distinct from MAX TWO pending reminders; no second watcher. No new system/queue/cron/reader. STOP at owner gate.");
  if (record.pr_number) details.push(`Associated PR: ${REPO}/pull/${record.pr_number}`);
  if (!isNew && (record.owner_question || record.github_owner_question)) details.push(
    "Owner question remains: check this chat for the owner's actual reply, record it in the existing PR and clear only a resolved gate. Continue approved CI/review fixes; courier delivery is not approval.");
  if (!isNew) details.push(`REQUIRED NEXT ACTION: ${action}. Continue from where you left off in THIS SAME chat, branch and PR. Head: ${record.head_sha || 'none'}; branch: ${record.branch || 'unknown'}; PR: ${record.pr_number ? REPO + '/pull/' + record.pr_number : 'not opened'}; CI: ${record.ci_state || 'unknown'}; Codex: ${record.codex_state || 'unknown'}; base current: ${record.base_current !== false}, reviewed: ${record.review_base_current !== false}. If PR is missing, open its draft now. Re-read new owner comments and review threads; update the SAME PR Comment disposition checklist and fix unfinished issues. Rerun CI after fixes; request Codex once on a stable ready head after parent merge, not per push/comment; stop for owner approval only, never duplicate a PR or chat.`);
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
