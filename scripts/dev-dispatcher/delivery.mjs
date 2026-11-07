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
  const details = [
    `Base branch: ${record.base_branch || 'main'}. ${record.prerequisite_pr ? `Predecessor PR: ${record.prerequisite_pr}.` : ''}`,
    'MANDATORY SKILLS: Read .claude/skills/aicafe-proof-gate/SKILL.md, .claude/skills/aicafe-dependency-check/SKILL.md and docs/rules/skills.md in full before coding. Apply relevant listed skills; include a per-acceptance test/evidence matrix in the PR. Do not claim complete based on a checklist or green CI alone.',
    'Finish implementation and its acceptance evidence BEFORE opening the PR. Open it READY FOR REVIEW (not draft); allow the existing PR-opening Codex review to run ONCE, not on every commit. Ask Codex to check all task acceptance scenarios, missing wiring and integration, not only style. After review, stay in the same working session if possible; do not run a polling loop. Address substantive findings and prove completion before merge.',
    `Task ${task.id}: ${task.title}`,
    `Goal: ${task.goal}`,
    `Approved file ownership: ${task.exclusive_files.join(', ')}`,
    `Task brief: ${REPO}/blob/main/${taskBrief}#task-${task.id}`,
    `Read ${REPO}/blob/main/AGENTS.md and PROGRESS.md before coding.`,
    'Work in the SAME PR and conversation for follow-ups. Follow repository approvals, CI, Codex and merge gates.',
    'Do not claim that a merge proves integration or production release.',
  ];
  if (record.pr_number) details.push(`Associated PR: ${REPO}/pull/${record.pr_number}`);
  if (!isNew) details.push(`Required next action: ${action}. Re-check the current PR head, checks and review comments before making changes.`);
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
