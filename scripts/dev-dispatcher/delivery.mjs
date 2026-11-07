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
  const stacked = Boolean(record.prerequisite_pr && record.base_branch && record.base_branch !== 'main');
  const details = [
    `Task acceptance requirements (each must have executable evidence): ${JSON.stringify(task.acceptance || [])}`,
    `Dependency task IDs: ${JSON.stringify(task.depends_on || [])}. Prerequisite branch/PR must be integrated before completion.`,
    `Your working branch: ${record.branch || ('feat/aicafe-task-' + task.id)}. Base branch: ${record.base_branch || 'main'}.`,
    `Base branch: ${record.base_branch || 'main'}. ${record.prerequisite_pr ? `Predecessor PR: ${record.prerequisite_pr}.` : ''}`,
    'MANDATORY SKILLS: Read .claude/skills/aicafe-proof-gate/SKILL.md, .claude/skills/aicafe-dependency-check/SKILL.md and docs/rules/skills.md in full before coding. Apply relevant listed skills; include a per-acceptance test/evidence matrix in the PR. Do not claim complete based on a checklist or green CI alone.',
    'Before PR: implement every acceptance criterion and its executable test. Put exactly one <!-- aicafe-acceptance-evidence {JSON} --> comment in the PR body, with task_id, head_sha, base_sha and acceptance rows in approved order (id, test_file, command, result=passed). Only use node --test <test_file> or npx vitest run <test_file> as exact executable commands. The separate AI CAFE Acceptance Evidence workflow runs these tests from the exact PR head using its runner from trusted main, with no shell evaluation of your inputs. After CI succeeds, update the same comment with ci_run_id (the baseline run), acceptance_run_id (the execution-proof workflow run) and its actual acceptance job_url for every row. Evidence from a previous head/base or a skipped job is not proof. GitHub verifies the run and the matching execution artifact before merge.',
    `Include exactly one <!-- aicafe-task-id ${task.id} --> marker in the PR description so manually opened PRs can be linked without guessing.`,
    stacked
      ? `DEPENDENT TASK: OPEN A DRAFT PR IMMEDIATELY, even before implementation is finished. Base it on the existing prerequisite branch ${record.base_branch} (PR #${record.prerequisite_pr}), not main. Work and keep CI green on that stacked branch. After prerequisite integration is proven on main, retarget/rebase this PR to current main, rerun acceptance, CI and relevant Codex review, then mark ready and merge under AGENTS.md. Do not wait to open the draft.`
      : 'INDEPENDENT TASK: Implement and verify the work before opening a READY FOR REVIEW (non-draft) PR against current main. Keep the established PR-opening Codex review behavior; do not request a paid review on every commit.',
    'Ask Codex to check all acceptance scenarios, missing wiring and integration, not only style. Address substantive findings, keep working in this PR and conversation, and prove completion before merge.',
    `Task ${task.id}: ${task.title}`,
    `Goal: ${task.goal}`,
    `Approved file ownership: ${task.exclusive_files.join(', ')}`,
    `Task brief: ${REPO}/blob/main/${taskBrief}#task-${task.id}`,
    `Read ${REPO}/blob/main/AGENTS.md and PROGRESS.md before coding.`,
    'Work in the SAME PR and conversation for follow-ups. Follow repository approvals, CI, Codex and merge gates.',
    'Do not claim that a merge proves integration or production release.',
  ];
  if (record.pr_number) details.push(`Associated PR: ${REPO}/pull/${record.pr_number}`);
  if (!isNew) details.push(`Required next action: ${action}. Last GitHub-observed commit: ${record.head_sha || 'none'}. Continue from THAT exact commit on branch ${record.branch || 'unknown'}; do not restart, overwrite, or duplicate completed work. PR: ${record.pr_number ? REPO + '/pull/' + record.pr_number : 'not opened'}. CI: ${record.ci_state || 'unknown'}. Codex: ${record.codex_state || 'unknown'}. Base current: ${record.base_current !== false}. Base changed review required: ${record.review_base_current === false}. If branch update conflicts, resolve in the existing coding PR; re-run relevant CI and a final relevant Codex review after the base/head changes. Inspect current PR head, checks, review comments and remaining acceptance evidence. Fix only the unfinished items; push to the SAME branch and PR.`);
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
