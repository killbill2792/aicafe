// Lightweight, project-neutral private-queue -> OpenClaw handoff.
// This process has no AI CAFE GitHub token, repo checkout, or source-code permissions.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const safeName = s => typeof s === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(s);
const sha = s => createHash('sha256').update(s).digest('hex');
const ACTION_INTENTS = {
  assign: 'start_new_chat',
  repair_ci: 'continue_existing_chat', repair_review: 'continue_existing_chat',
  continue_pr: 'continue_existing_chat', pre_pr_reminder: 'continue_existing_chat',
  // Dispatcher v2 uses reason-specific names; these are the same saved-chat
  // continuation intent, NOT new receipt types or a new courier.
  ci_failed: 'continue_existing_chat', codex_comments: 'continue_existing_chat',
  parent_merged: 'continue_existing_chat', owner_answered: 'continue_existing_chat',
  dependency_proven: 'continue_existing_chat',
  idle_continue: 'continue_existing_chat',
  plan: 'continue_existing_chat', brainstorm: 'continue_existing_chat'
};

export function validateHandoff(action, task) {
  const d = action?.delivery;
  if (action?.status !== 'planned' || !['muse', 'dave'].includes(action.delivery_owner) || task?.approved !== true || !d || d.version !== 1 ||
      !safeName(d.task_id) || !safeName(d.project?.id) || !safeName(d.provider) ||
      !['chatgpt', 'claude'].includes(d.provider) ||
      !['start_new_chat', 'continue_existing_chat'].includes(d.intent) ||
      d.task_id !== action.task_id || d.action_id !== action.key ||
      ACTION_INTENTS[action.type] !== d.intent ||
      (action.head_sha && action.head_sha !== task.head_sha) ||
      task.agent !== d.provider || typeof d.project?.name !== 'string' ||
      d.project.name.length > 100 || typeof d.prompt !== 'string' ||
      !d.prompt.trim() || d.prompt.length > 12000 ||
      (!d.prompt_hash || d.prompt_hash !== sha(d.prompt)) ||
      typeof d.base_branch !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(d.base_branch) ||
      !/^[a-f0-9]{64}$/.test(d.approval_hash || '') ||
      d.approval_hash !== task.approval_hash) return false;
  const prFollowup = ['repair_ci', 'repair_review', 'continue_pr',
    'ci_failed', 'codex_comments', 'owner_answered', 'dependency_proven', 'idle_continue'].includes(action.type);
  if (prFollowup && (!Number.isInteger(task.pr_number) || task.github_state !== 'open' ||
      !task.head_sha || action.head_sha !== task.head_sha)) return false;
  // Parent-merged must carry a non-null exact child head: the courier
  // rejects unanchored instructions. A newer push invalidates the old
  // delivery and the reconciler may prepare a fresh one.
  if (action.type === 'parent_merged') {
    const merged = task.parent_merged_sha;
    if (!Number.isInteger(task.pr_number) || task.github_state !== 'open' ||
        !task.head_sha || task.base_branch !== 'main' ||
        d.base_branch !== 'main' || action.head_sha !== task.head_sha ||
        !/^[a-f0-9]{40}$/.test(merged || '') ||
        task.branch_maintenance_merge_sha !== merged ||
        task.last_parent_rebase_sha === merged ||
        action.key !== 'parent_merged:' + encodeURIComponent(action.task_id) + ':' + merged)
      return false;
  }
  if (action.type === 'pre_pr_reminder' && Number.isInteger(task.pr_number)) return false;
  if (d.intent === 'start_new_chat') return d.conversation_url == null && !task.conversation_ref;
  return validTarget(d.provider, d.conversation_url) && task.conversation_ref === d.conversation_url;
}

export function validTarget(provider, raw) {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return false;
    if (provider === 'chatgpt') return u.host === 'chatgpt.com' && /^\/(?:c|g\/[\w-]+\/c)\/[\w-]+\/?$/.test(u.pathname);
    return provider === 'claude' && u.host === 'claude.ai' && /^\/chat\/[\w-]+\/?$/.test(u.pathname);
  } catch { return false; }
}

export function pendingActions(state) {
  if (state?.version !== 1 || !state.tasks || !state.actions) throw new Error('Invalid ledger');
  return Object.entries(state.actions)
    .map(([key, value]) => ({ ...value, key }))
    .filter(a => validateHandoff(a, state.tasks[a.task_id]))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

export function agentInstruction(action) {
  const d = action.delivery;
  if (!d) throw new Error('Missing delivery');
  const destination = d.intent === 'start_new_chat'
    ? `Find the Project named ${JSON.stringify(d.project.name)} in the existing ${d.provider} Chrome tab and create a new chat INSIDE that project.`
    : `Open EXACTLY this existing ${d.provider} conversation: ${d.conversation_url}. Never create another chat for this task.`;
  return [
    `You are the browser-only project coordinator. This is approved queue action ${JSON.stringify(action.key)} for project ${JSON.stringify(d.project.id)}.`,
    'Use the existing authenticated OpenClaw Chrome extension profile (chrome). Never use the isolated browser.',
    'Navigate adaptively by observing relevant navigation and composer controls; no fixed coordinates.',
    destination,
    'If login, destination, project, composer, or permission is ambiguous, STOP without sending. Never guess.',
    'Do not use shell, filesystem, GitHub, code-editing tools, external APIs, or elevated permissions.',
    'Do not read, summarize, collect, or quote assistant responses or conversation transcripts.',
    'Reuse the existing persistent browser tab for this conversation when available; verify the provider, project and exact conversation URL before sending. Never assume a tab number remains valid after restart.',
    'For idle reminders only, inspect the bottom of the existing conversation to determine whether the coding assistant is still generating; do not read or summarize its messages. If active or uncertain, do not submit.',
    'Check that the destination is correct and the composer is idle; submit the following instruction ONCE only.',
    '--- BEGIN APPROVED INSTRUCTION ---',
    d.prompt,
    '--- END APPROVED INSTRUCTION ---',
    `After any attempt, report only: sent_unverified / blocked / uncertain, conversation URL, and prompt_hash ${d.prompt_hash}. Never claim provider-confirmed delivery.`,
  ].join('\n');
}

export async function fetchLedger({ repo, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !token) throw new Error('Private ledger repository and read token required');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const meta = await fetchImpl(`https://api.github.com/repos/${repo}`, { headers });
  if (!meta.ok || (await meta.json()).private !== true) throw new Error('Ledger repository must be private and accessible');
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/contents/dispatcher/state.json?ref=main`, { headers });
  if (!response.ok) throw new Error(`Cannot read private ledger: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.content) throw new Error('Ledger missing content');
  const decoded = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (decoded.length > 1_000_000) throw new Error('Ledger too large');
  return JSON.parse(decoded);
}

async function safeDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('Unsafe receipt directory');
}

// Persistent per-task hold survives worker restarts. A reserved, failed, uncertain,
// or unverified turn blocks *all later action keys* for this task until a human
// reconciles the conversation/ledger. Never auto-clear an uncertain hold.
export function taskHoldFile(dir, action) {
  return path.join(dir, sha('task:' + action.delivery.project.id + ':' + action.task_id) + '.hold.json');
}
export async function reserveTaskHold(dir, action) {
  await safeDir(dir);
  const file = taskHoldFile(dir, action);
  const record = { action_sha256: sha(action.key), task_id: action.task_id,
    project: action.delivery.project.id, status: 'reserved', at: new Date().toISOString() };
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(record) + '\n'); await h.sync(); }
  finally { await h.close(); }
  return { file, record };
}

export async function reserveReceipt(dir, action) {
  await safeDir(dir);
  const file = path.join(dir, sha(action.key) + '.json');
  const record = { action_sha256: sha(action.key), project: action.delivery.project.id, task_id: action.task_id,
    status: 'reserved', at: new Date().toISOString() };
  const h = await fs.open(file, 'wx', 0o600); // existing or uncertain action must never replay
  try { await h.writeFile(JSON.stringify(record) + '\n'); await h.sync(); } finally { await h.close(); }
  return { file, record };
}

async function updateReceipt(file, record, status) {
  const next = { ...record, status, at: new Date().toISOString() };
  const temp = file + '.' + process.pid + '.tmp';
  const h = await fs.open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(next) + '\n'); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
}

export async function invokeOpenClaw(action, { dir, executable = 'openclaw', spawnImpl = spawn, timeoutMs = 300000 } = {}) {
  const { file, record } = await reserveReceipt(dir, action);
  const messageFile = path.join(dir, sha(action.key) + '.message');
  const instruction = agentInstruction(action);
  try {
    const h = await fs.open(messageFile, 'wx', 0o600);
    try { await h.writeFile(instruction); } finally { await h.close(); }
    // Do NOT forward queue/GitHub credentials to the OpenClaw agent process.
    const permitted = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => permitted.has(k)));
    const session = `queue-${action.delivery.project.id}-${action.task_id}`.replace(/[^\w-]/g, '-');
    const code = await new Promise(resolve => {
      const child = spawnImpl(executable, ['agent', '--session-key', session, '--message-file', messageFile],
        { env, stdio: ['ignore', 'ignore', 'ignore'] });
      let resolved = false;
      const timer = setTimeout(() => { if (!resolved) { child.kill('SIGTERM'); resolve(null); } }, timeoutMs);
      child.once('error', () => { resolved = true; clearTimeout(timer); resolve(null); });
      child.once('close', exit => { resolved = true; clearTimeout(timer); resolve(exit); });
    });
    const status = code === 0 ? 'agent_turn_completed_delivery_unverified' : 'uncertain';
    await updateReceipt(file, record, status);
    return status;
  } catch {
    await updateReceipt(file, record, 'uncertain');
    return 'uncertain';
  } finally {
    await fs.rm(messageFile, { force: true });
  }
}

export async function runOnce({ repo = process.env.DISPATCH_LEDGER_REPO,
  token = process.env.DISPATCH_LEDGER_READ_TOKEN,
  receiptDir = path.join(os.homedir(), '.local', 'state', 'dave-handoff', 'receipts'),
  sendEnabled = process.env.DAVE_HANDOFF_SEND_ENABLED === '1',
  fetchImpl = fetch, invoke = invokeOpenClaw } = {}) {
  const state = await fetchLedger({ repo, token, fetchImpl });
  const eligible = pendingActions(state);
  // A prior completed/uncertain attempt is never replayed, even if the private ledger
  // still reports it as planned. Continue to the next unattempted task instead.
  await safeDir(receiptDir);
  let action;
  for (const candidate of eligible) {
    if (sendEnabled && candidate.delivery_owner !== "dave") continue;
    // Ignore a new GitHub event/action key if a previous browser turn for the
    // same task is reserved, uncertain, or not provider-verified.
    try { await fs.access(taskHoldFile(receiptDir, candidate)); continue; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.access(path.join(receiptDir, sha(candidate.key) + '.json')); }
    catch (e) { if (e.code === 'ENOENT') { action = candidate; break; } throw e; }
  }
  if (!action) return { status: 'idle', pending: eligible.length, already_attempted: eligible.length };
  if (!sendEnabled) return { status: 'dry_run', pending: eligible.length, project: action.delivery.project.id,
    task_id: action.task_id, intent: action.delivery.intent };
  // Muse owns new actions by default. Dave may send only after GitHub explicitly
  // reassigns ownership to Dave following a verified Muse non-delivery.
  if (action.delivery_owner !== 'dave') return { status:'held_for_muse', task_id:action.task_id };
  let hold;
  try { hold = await reserveTaskHold(receiptDir, action); }
  catch (error) {
    if (error.code === 'EEXIST') return { status: 'held', task_id: action.task_id, pending: eligible.length };
    throw error;
  }
  let status = 'uncertain';
  try { status = await invoke(action, { dir: receiptDir }); }
  catch { status = 'uncertain'; }
  // Persist the hold even on success: CLI exit 0 cannot prove a browser send.
  await updateReceipt(hold.file, hold.record, status);
  return { status, task_id: action.task_id, pending: eligible.length };
}
