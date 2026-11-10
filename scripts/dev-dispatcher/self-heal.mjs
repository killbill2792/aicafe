// Pure self-healing helpers for the existing trusted-main dispatcher tick.
// No separate poller, write path, approval or merge gate.
export const REQUIRED_INTEGRATION_STEPS = [
  'TypeScript','ESLint','Full regression tests','Dispatcher regression tests',
  'Production build','Capability integration scenarios'
];
export function trackScheduleGap(state, {eventName, now, observedScheduleAt = null} = {}) {
  const next = structuredClone(state);
  const at = new Date(now).toISOString();
  next.schedule_health ||= {};
  const health = next.schedule_health;
  const last = health.last_schedule_at || observedScheduleAt;
  if (eventName === 'schedule') {
    if (last && Date.parse(at) - Date.parse(last) > 15 * 60_000)
      health.missed_schedule = {last_schedule_at:last, noticed_at:at,
        gap_minutes:Math.floor((Date.parse(at)-Date.parse(last))/60_000)};
    health.last_schedule_at = at;
    return next;
  }
  if (!health.last_schedule_at && last) health.last_schedule_at = last;
  if (last && Date.parse(at)-Date.parse(last) > 15*60_000 &&
      health.missed_schedule?.last_schedule_at !== last)
    health.missed_schedule = {last_schedule_at:last, noticed_at:at,
      gap_minutes:Math.floor((Date.parse(at)-Date.parse(last))/60_000)};
  return next;
}
export function verifiedMergedProof({run,job,artifact=null,taskId,mergeSha} = {}) {
  if (!/^[a-f0-9]{40}$/.test(mergeSha||'') ||
      run?.name !== 'AI CAFE Integration Proof' || run.head_branch !== 'main' ||
      !['push','workflow_dispatch'].includes(run.event) ||
      run.status !== 'completed' || run.conclusion !== 'success' ||
      job?.name !== 'Required merged-main integration checks' ||
      job.status !== 'completed' || job.conclusion !== 'success') return null;
  // A push on the exact merge commit is authoritative, including owner merges.
  // A later workflow_dispatch must carry an exact-SHA artifact to disambiguate.
  const exactPush = run.event === 'push' && run.head_sha === mergeSha;
  const artifactExact = artifact && artifact.task_id === taskId &&
    artifact.run_id === run.id && artifact.head_sha === mergeSha &&
    artifact.base_sha === mergeSha;
  if (!exactPush && !artifactExact) return null;
  if (artifact && !artifactExact) return null;
  if (!REQUIRED_INTEGRATION_STEPS.every(name =>
      job.steps?.some(step => step.name === name &&
        step.status === 'completed' && step.conclusion === 'success'))) return null;
  // Preserve actual check identities. Do not pretend that unsubmitted signed
  // task acceptance scenarios ran; integration evidence is merged-main checks.
  const checks = REQUIRED_INTEGRATION_STEPS.map((name,i)=>({
    id:String(i+1),check:name,result:'passed'
  }));
  return {main_sha:mergeSha,merged_sha:mergeSha,workflow_run_id:run.id,
    conclusion:'success',proof_basis:artifactExact?'exact_sha_artifact':'exact_sha_push',
    required_checks:checks,required_scenarios:checks,
    ...(artifactExact && Array.isArray(artifact.acceptance) ?
      {task_acceptance:artifact.acceptance} : {})};
}
export function recordDrift(state, previous, observed, at = new Date().toISOString()) {
  const next = structuredClone(state);
  const fields = ['head_sha','base_sha','base_current','codex_state',
    'codex_reviewed_sha','threads_resolved','github_state','approval_hash'];
  const updates=[];
  for (const [id,now] of Object.entries(next.tasks||{})) {
    const before=previous.tasks?.[id];
    if (!before) continue;
    for (const field of fields) {
      if (before[field] !== now[field] && now[field] !== undefined)
        updates.push({task_id:id,field,from:before[field]??null,to:now[field]??null});
    }
    const link = next.pr_chat_links?.[String(now.pr_number)];
    if (link && link.conversation_url !== now.conversation_ref)
      updates.push({task_id:id,field:'chat_link',from:now.conversation_ref||null,
        to:link.conversation_url});
  }
  if (updates.length) {
    next.drift_fixed ||= [];
    next.drift_fixed.push({at,changes:updates.slice(0,30)});
    next.drift_fixed = next.drift_fixed.slice(-20);
  }
  return next;
}
export function acceptMuseOwnerReply(state, receipt, {authenticatedCourier}={}) {
  if (authenticatedCourier !== 'muse' || receipt?.kind !== 'owner_reply' ||
      typeof receipt.text !== 'string' || !receipt.text.trim() ||
      receipt.text.length > 400 || !receipt.target ||
      typeof receipt.event_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.event_id))
    throw new Error('Invalid authenticated owner reply');
  const next=structuredClone(state);
  const target=receipt.target;
  const task=typeof target.task_id==='string' ? next.tasks?.[target.task_id] :
    Object.values(next.tasks||{}).find(t=>t.pr_number===target.pr_number);
  if (!task) throw new Error('Owner reply target not found');
  task.owner_reply_events ||= {};
  if (task.owner_reply_events[receipt.event_id]) return next;
  task.owner_reply_events[receipt.event_id] = {
    text:receipt.text.trim(),target,at:receipt.submitted_at||new Date().toISOString(),
    courier:'muse'
  };
  task.owner_answer_text=receipt.text.trim();
  task.owner_answer_key='muse:'+receipt.event_id;
  return next;
}
