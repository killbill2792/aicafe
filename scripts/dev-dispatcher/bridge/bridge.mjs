// Lightweight, project-neutral private-queue -> OpenClaw handoff.
// This process has no AI CAFE GitHub token, repo checkout, or source-code permissions.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const safeName = s => typeof s === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(s);
const sha = s => createHash('sha256').update(s).digest('hex');
const ACTION_INTENTS = { assign: 'start_new_chat', repair_ci: 'continue_existing_chat', repair_review: 'continue_existing_chat', continue_pr: 'continue_existing_chat', pre_pr_reminder: 'continue_existing_chat' };

export function validateHandoff(action, task) {
  const d = action?.delivery;
  if (action?.status !== 'planned' || task?.approved !== true || !d || d.version !== 1 ||
      !safeName(d.task_id) || !safeName(d.project?.id) || !safeName(d.provider) ||
      !['chatgpt', 'claude'].includes(d.provider) ||
      !['start_new_chat', 'continue_existing_chat'].includes(d.intent) ||
      d.task_id !== action.task_id || d.action_id !== action.key ||
      ACTION_INTENTS[action.type] !== d.intent ||
      (action.head_sha && action.head_sha !== task.head_sha) ||
      task.agent !== d.provider || typeof d.project?.name !== 'string' ||
      d.project.name.length > 100 || typeof d.prompt !== 'string' ||
      !d.prompt.trim() || d.prompt.length > 12000) return false;
  if (d.intent === 'start_new_chat') return d.conversation_url == null;
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
    'Check that the destination is correct and the composer is idle; submit the following instruction ONCE only.',
    '--- BEGIN APPROVED INSTRUCTION ---',
    d.prompt,
    '--- END APPROVED INSTRUCTION ---',
    'After any attempt, report only: sent_unverified / blocked / uncertain and the resulting conversation URL if visible in the address bar. Never claim provider-confirmed delivery.',
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
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DISPATCH_|^GITHUB_/.test(k)));
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
    try { await fs.access(path.join(receiptDir, sha(candidate.key) + '.json')); }
    catch (e) { if (e.code === 'ENOENT') { action = candidate; break; } throw e; }
  }
  if (!action) return { status: 'idle', pending: eligible.length, already_attempted: eligible.length };
  if (!sendEnabled) return { status: 'dry_run', pending: eligible.length, project: action.delivery.project.id,
    task_id: action.task_id, intent: action.delivery.intent };
  const status = await invoke(action, { dir: receiptDir });
  return { status, task_id: action.task_id, pending: eligible.length };
}
