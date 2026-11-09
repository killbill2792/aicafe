// Courier receipts are deposited as private GitHub files, never as public signals.
// GitHub verifies authenticated GitHub commit actor, exact action/hash/URL and CAS state.
import { createHash } from 'node:crypto';
import { acceptDeliveryReceipt } from './receipt.mjs';
import { validConversationUrl } from './delivery.mjs';
import { acceptOwnerNoticeReceipt } from './alerts.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');

export async function collectReceipts({ ledger, allowedActors }) {
  if (!allowedActors?.length) return [];
  const list = await ledger.request('/contents/dispatcher/receipts?ref=main');
  if (list.absent) return [];
  if (!Array.isArray(list)) throw new Error('Receipt inbox must be a directory');
  if (list.length >= 1000) throw new Error('Receipt inbox pagination required');
  const receipts = [];
  for (const entry of list) {
    if (entry.type !== 'file' || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const meta = await ledger.request(`/commits?path=${encodeURIComponent(entry.path)}&per_page=1`);
    const actor = meta?.[0]?.author?.login;
    if (!allowedActors.includes(actor)) continue;
    const blob = await ledger.request(`/contents/${entry.path}?ref=main`);
    if (!blob.content) continue;
    const receipt = JSON.parse(Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    const identity = receipt.kind === 'owner_notice'
      ? 'owner:' + receipt.notice_id + ':' + receipt.notice_hash
      : receipt.action_id + ':' + receipt.prompt_hash;
    if (sha(identity) + '.json' !== entry.name) continue;
    receipts.push({ receipt, actor });
  }
  return receipts;
}

export function applyReceipts(state, inbox, actorMap) {
  let next = state;
  for (const {receipt, actor} of inbox) {
    const courier = actorMap[actor];
    if (!courier) continue;
    // Historical receipts stay in the inbox; never replay or revive cancelled actions.
    if (receipt.kind === 'owner_notice') {
      if (next.owner_alerts?.[receipt.notice_id]?.status !== 'planned') continue;
      next = acceptOwnerNoticeReceipt(next, receipt, { authenticatedCourier: courier });
      continue;
    }
    const action = next.actions?.[receipt.action_id];
    // After the PR appears, initial assignment receipts can arrive late.
    // Invalid legacy placeholder destinations (for example local-chatgpt URLs)
    // must not poison the entire inbox and prevent unrelated valid chat recovery.
    // Never mark those invalid receipts as delivered or trusted.
    const late = action?.status === 'cancelled_stale_head' && action.type === 'assign';
    if (action?.status !== 'planned' && !late) continue;
    if (late) {
      const task = next.tasks?.[action.task_id];
      // No historical receipt may stop unrelated tasks after its own PR closed,
      // approval changed, chat was already registered, or ownership diverged.
      if (!task || !task.approved || task.github_state !== 'open' ||
          !Number.isInteger(task.pr_number) || task.conversation_ref ||
          receipt.action_id !== 'assign:' + task.task_id ||
          action.task_id !== task.task_id ||
          task.branch !== 'feat/aicafe-task-' + task.task_id)
        continue;
      if (receipt.approval_hash !== task.approval_hash ||
          receipt.approval_hash !== action.delivery?.approval_hash ||
          !validConversationUrl(action.delivery?.provider, receipt.conversation_url)) {
        task.chat_recovery_blocker = 'invalid_or_unsigned_original_receipt';
        continue;
      }
    }
    next = acceptDeliveryReceipt(next, receipt, { authenticatedCourier: courier });
  }
  return next;
}
