// Courier receipts are deposited as private GitHub files, never as public signals.
// GitHub verifies authenticated GitHub commit actor, exact action/hash/URL and CAS state.
import { createHash } from 'node:crypto';
import { acceptDeliveryReceipt } from './receipt.mjs';
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
    if (sha(receipt.action_id + ':' + receipt.prompt_hash) + '.json' !== entry.name) continue;
    receipts.push({ receipt, actor });
  }
  return receipts;
}

export function applyReceipts(state, inbox, actorMap) {
  let next = state;
  for (const {receipt, actor} of inbox) {
    const courier = actorMap[actor];
    if (!courier) continue;
    if (next.actions?.[receipt.action_id]?.status === 'submitted') continue;
    next = acceptDeliveryReceipt(next, receipt, { authenticatedCourier: courier });
  }
  return next;
}
