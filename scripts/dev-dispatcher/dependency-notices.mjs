// Private-ledger notices for newly proven merged-main dependencies.
// Never sends chat messages, relaxes merge gates or trusts author claims.
import { createHash } from 'node:crypto';
import { approvalMatches, createDelivery } from './delivery.mjs';

const proven = status => ['integrated_proven','released_proven'].includes(status);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0,20);

export function queueDependencyNotices(state, queue, now = new Date().toISOString()) {
  const byId = new Map((queue?.tasks || []).map(task => [task.id,task]));
  const pending = new Set(Object.values(state.actions || {})
    .filter(a => ['planned','claimed','uncertain'].includes(a.status))
    .map(a => a.task_id));
  const pendingPrs = new Set(Object.values(state.actions || {})
    .filter(a => ['planned','claimed','uncertain'].includes(a.status))
    .map(a => state.tasks?.[a.task_id]?.pr_number).filter(Number.isInteger));
  const queued = [];
  for (const [id, rec] of Object.entries(state.tasks || {})) {
    const task = byId.get(id);
    if (!task || !Number.isInteger(rec.pr_number) || rec.github_state !== 'open' ||
        rec.approved !== true || !rec.conversation_ref || !rec.head_sha ||
        pending.has(id) || pendingPrs.has(rec.pr_number) ||
        !approvalMatches(task,rec.approval_hash)) continue;
    if (rec.parent_merged_sha &&
        rec.branch_maintenance_merge_sha !== rec.parent_merged_sha) continue;
    const completed = (task.depends_on || []).filter(dep => {
      const prior=state.tasks?.[dep];
      return proven(prior?.status) && /^[a-f0-9]{40}$/.test(prior?.merge_sha || '');
    }).sort();
    if (!completed.length) continue;
    const fingerprint = hash(JSON.stringify(completed.map(dep =>
      [dep,state.tasks[dep].merge_sha])));
    if (rec.last_dependency_proven_signature === fingerprint) continue;
    const key = 'dependency_proven:' + encodeURIComponent(id) + ':' + fingerprint +
      ':' + rec.head_sha;
    if (state.actions[key]) continue;
    const text = completed.map(dep => dep + ' (' + state.tasks[dep].merge_sha + ')').join(', ');
    let delivery;
    try {
      delivery = createDelivery({task,record:{...rec,dependency_proven_text:text},
        action:'dependency_proven',actionId:key});
    } catch (error) {
      console.error('Task ' + id + ' dependency notice failed: ' + error.message);
      continue;
    }
    rec.dependency_proven_text = text;
    state.actions[key] = {task_id:id,type:'dependency_proven',status:'planned',
      delivery_owner:'muse',head_sha:rec.head_sha,dependency_signature:fingerprint,
      created_at:now,delivery};
    pending.add(id);
    pendingPrs.add(rec.pr_number);
    queued.push(id);
  }
  return queued;
}
