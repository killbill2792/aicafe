import { createHash } from 'node:crypto';
import { editableFiles, usedFiles } from './core.mjs';
export const promptHash = prompt => createHash('sha256').update(prompt).digest('hex');
// Approved plan metadata -> bounded, provider-neutral browser handoff.
// Generated ONLY on trusted main by the existing deterministic dispatcher.
const PROVIDERS = new Set(['chatgpt', 'claude']);
const ACTIONS = new Set(['assign', 'repair_ci', 'repair_review', 'continue_pr', 'pre_pr_reminder',
  'codex_comments', 'ci_failed', 'parent_merged', 'owner_answered', 'idle_continue', 'plan', 'brainstorm']);
const REPO = 'https://github.com/killbill2792/aicafe';

// POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING is mandatory and remains
// linked from the compact step prompt to AGENTS.md, docs/rules/pos-data.md,
// #398 and the signed queue. The source of truth is NOT copied into delivery.
// D4A Approach B (change-driven Toast family checks) stays owner-approved
// architecture only; exact task coding approval and all proof gates still apply.
// The short prompt is not a substitute for any of those linked contracts.
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
  const edits = editableFiles(task);
  if (!task || task.architecture_approval?.approved !== true ||
      !['architecture_approved','ready'].includes(task.state) ||
      !Array.isArray(edits) || !edits.length ||
      record?.approved !== true || !ACTIONS.has(action) ||
      !PROVIDERS.has(record.agent))
    throw new Error('Task is not authorized for browser delivery');
  if (typeof actionId !== 'string' || !actionId || actionId.length > 400)
    throw new Error('Invalid action ID');
  const authorization = approvalSignature(task);
  if (record.approval_hash && record.approval_hash !== authorization)
    throw new Error('Task approval or scope changed');
  const isNew = action === 'assign';
  const url = record.conversation_ref || null;
  if (!isNew && !url) throw new Error('Follow-up requires a saved conversation URL');
  if (url && !validConversationUrl(record.agent,url))
    throw new Error('Invalid destination URL');
  const taskBrief = task.brief?.split('#')[0];
  if (!/^docs\/plans\/[a-zA-Z0-9_./-]+\.md$/.test(taskBrief || '') ||
      taskBrief.includes('..')) throw new Error('Invalid task brief');
  const project = {id:'aicafe',name:'AI CAFE'};
  const links = [
    'Authority: ' + REPO + '/blob/main/AGENTS.md',
    'Progress (read-only): ' + REPO + '/blob/main/PROGRESS.md',
    'Skills: ' + REPO + '/blob/main/docs/rules/skills.md',
    'PR lifecycle: ' + REPO + '/blob/main/.claude/skills/aicafe-pr-lifecycle/SKILL.md',
    'Dependency/proof skills: ' + REPO + '/blob/main/.claude/skills/aicafe-dependency-check/SKILL.md and ' +
      REPO + '/blob/main/.claude/skills/aicafe-proof-gate/SKILL.md',
    'Signed queue: ' + REPO + '/blob/main/docs/plans/universal-supervisor-queue.json',
    'Task brief: ' + REPO + '/blob/main/' + task.brief
  ];
  const pr = record.pr_number ? REPO + '/pull/' + record.pr_number : 'not opened';
  const comments = (record.unresolved_codex_comments || []).slice(0,3)
    .map(c => '- ' + String(c.body || 'Unresolved thread').replace(/\s+/g,' ').slice(0,125) +
      (c.url && /^https:\/\/github\.com\//.test(c.url) ? ' ' + c.url : '')).join('\n');
  const reason = {
    codex_comments:'codex_comments: Resolve these unresolved Codex threads:\n' +
      (comments || 'Read unresolved threads on ' + pr) +
      '\nFix together; rerun CI before ONE re-review on the final head.',
    ci_failed:'ci_failed: ' + (record.ci_failure_job || 'Find failing CI job') + '\n' +
      (record.ci_failure_url || pr) +
      '\nDiagnose and fix the actual failure; do not weaken tests; rerun CI.',
    parent_merged:'parent_merged: Verified parent merge ' + (record.parent_merged_sha || 'unknown') +
      '. Rebase onto main and continue in this SAME child PR/chat. Dispatcher already retargeted to main ' +
      'and attempted update-branch: verify the updated head first, do not duplicate a successful update, ' +
      'and resolve conflicts if required. Rerun CI/acceptance; Codex once on the final green ready head.',
    owner_answered:'owner_answered: Authenticated GitHub owner answer: ' +
      String(record.owner_answer_text || 'Read PR decision').replace(/\s+/g,' ').slice(0,240) +
      '\nApply only within signed edits; reconcile the original PR comment ID and tests.',
    idle_continue:'idle_continue: Continue this SAME PR/chat. Finish scoped edits and tests; inspect ' +
      'latest CI/owner comments. When complete, put <!-- aicafe-coder-done --> in the PR body. ' +
      'Do not request Codex before CI green or on intermediate pushes.',
    repair_ci:'ci_failed: Diagnose the failing job on ' + pr + '; fix and rerun actual CI.',
    repair_review:'codex_comments: Read unresolved review threads on ' + pr +
      '; fix and rerun CI before exactly one final-head review.',
    continue_pr:'idle_continue: Continue this SAME PR/chat and CI; reconcile comments and evidence. ' +
      'Do not request Codex on intermediate pushes.',
    pre_pr_reminder:'pre_pr_reminder: Open the authorized early draft PR now on the correct base; ' +
      'continue implementation in this same conversation.',
    plan:'PLAN / SUPERPOWERS: Brainstorm one question at a time. Write the design; split it ' +
      'into tasks with explicit merge order; draw Mermaid diagrams. No implementation beyond approval.',
    brainstorm:'BRAINSTORM / SUPERPOWERS: Ask one question at a time. Write a design, split ' +
      'into tasks with merge order, and draw Mermaid diagrams; wait for owner approval.'
  };
  const stacked = Boolean(record.base_branch && record.base_branch !== 'main');
  const scope = edits.length > 8 ? 'Read exact edits in signed queue (' + edits.length + ' paths)' :
    edits.join(', ');
  const uses = usedFiles(task);
  const step = isNew
    ? 'assign: Open EARLY DRAFT now; branch ' + (record.branch || 'feat/aicafe-task-'+task.id) +
      '; PR base ' + (record.base_branch || 'main') +
      (record.prerequisite_pr ? ' (parent PR #' + record.prerequisite_pr + ')' : '') +
      (stacked ? '. Work/commit/test while parent is open; NO rebase or Codex until parent merged.' :
        '. Finish CI/evidence first; after coder-done/ready, one final-head Codex review.') +
      ' Use acceptance tests from signed queue; include exact execution links, ' +
      'PR comment dispositions and <!-- aicafe-coder-done --> only when actually complete.'
    : reason[action];
  const lines = [
    'AI CAFE ' + action + ' | task ' + task.id + ' | PR ' + pr,
    step,
    'Edits ONLY: ' + scope + '. Uses READ-ONLY: ' +
      (uses.length ? (uses.length > 4 ? 'see queue uses (' + uses.length + ')' : uses.join(', ')) : 'none') + '.',
    stacked && !isNew && action !== 'parent_merged' ?
      'Stacked child: keep coding/CI on parent base; NO rebase/Codex until parent merges.' : '',
    'Same approved task, same chat/PR. Respect owner questions, required acceptance, ' +
      'exact-head CI/Codex and existing merge/integration proof; no production/Vercel preview changes.',
    ...links
  ];
  if (/^POS0[a-f]$/.test(task.id)) lines.push(
    'POS0 preflight: follow AGENTS.md source-authority order; read ' +
    REPO + '/blob/main/docs/rules/pos-data.md and #398 handoff before coding. ' +
    'POS0a docs approval is NOT runtime proof; task-specific signed coding scope required.'
  );
  const prompt = lines.filter(Boolean).join('\n');
  if (Buffer.byteLength(prompt,'utf8') > 2048) throw new Error('Step prompt exceeds 2 KB');
  return {version:1,action_id:actionId,project,approval_hash:authorization,
    provider:record.agent,intent:isNew?'start_new_chat':'continue_existing_chat',
    base_branch:record.base_branch || 'main',conversation_url:url,
    task_id:task.id,prompt,prompt_hash:promptHash(prompt)};
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
