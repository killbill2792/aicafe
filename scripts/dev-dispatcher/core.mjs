// AI CAFE developer dispatcher: pure, deterministic decisions. No browser, LLM or merge effects.
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const taskKey = (id) => {
  if (!ID.test(id)) throw new Error("Invalid task id");
  return `aicafe:${id}`;
};
// New queues use edits (exclusive writes) and uses (read-only imports).
// Retain signed exclusive_files for existing approved tasks until migrated.
export const editableFiles = task => task?.edits ?? task?.exclusive_files ?? [];
export const usedFiles = task => task?.uses ?? [];
const validPath = path => typeof path === 'string' && Boolean(path) &&
  !path.startsWith('/') && !path.includes('*') && !path.includes('..');

export function resolveTaskBase(task, records = {}) {
  const deps = task?.depends_on || [];
  if (!deps.length) return {base_branch:'main',prerequisite_pr:null,waiting_for_parent:false};
  const unmerged = deps.filter(id => !['merged','integrated_proven','released_proven'].includes(records[id]?.status) &&
    records[id]?.github_state !== 'merged');
  if (!unmerged.length) return {base_branch:'main',prerequisite_pr:null,waiting_for_parent:false};
  const selected = unmerged.length === 1 ? unmerged[0] : task.stack_base_task;
  const parent = records[selected];
  if (!selected || !parent?.branch || parent.github_state !== 'open' ||
      !Number.isInteger(parent.pr_number)) return {blocked:true,reason:'unverified_parent_pr'};
  return {base_branch:parent.branch,prerequisite_pr:parent.pr_number,waiting_for_parent:true};
}

export function validateQueue(queue) {
  if (!Array.isArray(queue?.tasks) || !Array.isArray(queue?.merged_code_only)) throw new Error("Invalid queue");
  const all = new Set(queue.merged_code_only.map(x => x.id));
  const tasks = new Map();
  for (const task of queue.tasks) {
    taskKey(task.id);
    if (all.has(task.id) || tasks.has(task.id)) throw new Error(`Duplicate task ${task.id}`);
    if (!Array.isArray(task.depends_on) || !Array.isArray(task.acceptance) || !task.acceptance.length || !task.brief) throw new Error(`Incomplete task ${task.id}`);
    if (task.stack_base_task != null &&
      (typeof task.stack_base_task !== "string" || !task.depends_on.includes(task.stack_base_task)))
      throw new Error(`Invalid stack base for ${task.id}`);
    tasks.set(task.id, task);
  }
  // Read-only uses never reserve a path; only two writers conflict.
  const exclusiveOwners = new Map();
  for (const task of queue.tasks) {
    const edits = editableFiles(task), uses = usedFiles(task);
    if (!Array.isArray(edits) || !Array.isArray(uses) ||
        (edits.length===0 && approved(task)) || edits.some(path => !validPath(path)) ||
        new Set(edits).size !== edits.length)
      throw new Error('Invalid exclusive file ownership for ' + task.id);
    if (uses.some(path => !validPath(path)) || new Set(uses).size !== uses.length)
      throw new Error('Invalid read-only file usage for ' + task.id);
    for (const path of edits) {
      const owner = exclusiveOwners.get(path);
      if (owner) throw new Error('Overlapping exclusive file ownership: ' +
        path + ' (' + owner + ' and ' + task.id + ')');
      exclusiveOwners.set(path,task.id);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) {
      if (!all.has(id)) throw new Error(`Unknown prerequisite: ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of task.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of queue.tasks) visit(task.id);
  // Priority-zero work is a PROOF gate, not a normal stacked-PR dependency.
  // Validate the allowlist so a typo cannot silently unlock unrelated tasks.
  const foundation = queue.dispatch_rules?.architecture_foundation_proof_task;
  if (foundation !== undefined) {
    const downstream = queue.dispatch_rules?.architecture_foundation_dependent_task_ids;
    const signoff = queue.dispatch_rules?.architecture_foundation_implementation_approval;
    if (typeof foundation !== "string" || !tasks.has(foundation) ||
      !Array.isArray(downstream) || !downstream.length ||
      downstream.some(id => !tasks.has(id) || id === foundation) ||
      !signoff || typeof signoff.approved !== "boolean" ||
      (signoff.approved && (!/^[a-f0-9]{40}$/.test(signoff.merged_sha || "") ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(signoff.owner_review_url || ""))))
      throw new Error("Invalid architecture foundation proof gate");
  }
  const gate = queue.dispatch_rules?.priority_gate_task;
  if (gate !== undefined) {
    const allowed = queue.dispatch_rules?.priority_gate_allow_task_ids;
    if (typeof gate !== "string" || !tasks.has(gate) ||
      !Array.isArray(allowed) || !allowed.includes(gate) ||
      allowed.some(id => !tasks.has(id))) throw new Error("Invalid priority proof gate");
  }
  return tasks;
}
export const approved = (task) => task.architecture_approval?.approved === true && (task.state === "architecture_approved" || task.state === "ready");
export function integrated(taskId, _tasks, records) {
  // validateQueue already verified each dependency refers to a planned or historic ID.
  // Historic merged PRs still need an explicit durable integration proof.
  const rec = records[taskId];
  return rec?.status === "integrated_proven" || rec?.status === "released_proven";
}
// Read-only discovery approval is NOT approval of the resulting implementation plan.
// The owner must explicitly accept the exact on-main architecture merge SHA.
export function architectureFoundationReady(queue, records = {}) {
  const id = queue?.dispatch_rules?.architecture_foundation_proof_task;
  if (!id) return true;
  const proof = records[id];
  const signoff = queue.dispatch_rules.architecture_foundation_implementation_approval;
  const documentationAudit = id === "POS0a" && queue.tasks?.some(task =>
    task.id === id && task.test_kinds?.includes("read_only_audit"));
  // POS0a is an owner-merged design document, not a runtime integration.
  // Every actual implementation task continues to require its own execution proof.
  return (["integrated_proven", "released_proven"].includes(proof?.status) ||
    (documentationAudit && proof?.status === "merged")) &&
    signoff?.approved === true && signoff.merged_sha === proof?.merge_sha &&
    /^[a-f0-9]{40}$/.test(signoff.merged_sha || "") &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(signoff.owner_review_url || "");
}
// Merge gate receives only operational predecessors. The owner-accepted POS0a
// document may satisfy a dependency without pretending it ran production proof.
export function predecessorsForMerge(task, queue, records = {}) {
  const foundationId = queue?.dispatch_rules?.architecture_foundation_proof_task;
  const documentationAccepted = foundationId === "POS0a" &&
    queue?.tasks?.some(item => item.id === foundationId && item.test_kinds?.includes("read_only_audit")) &&
    architectureFoundationReady(queue, records);
  return (task.depends_on || [])
    .filter(dep => !(dep === foundationId && documentationAccepted))
    .map(dep => records[dep] || {status:"unknown"});
}
export function dispatchFrontier(queue, records = {}, capacity = null) {
  const tasks = validateQueue(queue);
  // The owner-approved capacity comes from the queue, not a stale hardcoded default.
  // No more than five ChatGPT chats or two Claude chats may be active.
  const requested = capacity ?? queue.capacity ?? { chatgpt: 5, claude: 2 };
  if (!Number.isInteger(requested.chatgpt) || requested.chatgpt < 0 || requested.chatgpt > 5 ||
    !Number.isInteger(requested.claude) || requested.claude < 0 || requested.claude > 2)
    throw new Error("Invalid dispatcher capacity");
  const remaining = { chatgpt: requested.chatgpt, claude: requested.claude };
  const occupiesSlot = r => ["assigned", "draft_open", "review_fixing"].includes(r.status) ||
    (r.status === "blocked_needs_owner" && (Boolean(r.conversation_ref) || Number.isInteger(r.pr_number)));
  for (const r of Object.values(records)) {
    if (occupiesSlot(r) && r.agent in remaining)
      remaining[r.agent] = Math.max(0, remaining[r.agent] - 1);
  }
  const claimed = new Set();
  for (const [id, record] of Object.entries(records)) {
    if (occupiesSlot(record)) {
      for (const path of editableFiles(tasks.get(id))) claimed.add(path);
    }
  }
  const actions = [];
  const gate = queue.dispatch_rules?.priority_gate_task;
  const gateProven = !gate || integrated(gate, tasks, records);
  const gateAllowed = new Set(queue.dispatch_rules?.priority_gate_allow_task_ids || []);
  // For initial Toast implementation, architecture approval is only meaningful
  // after the owner-reviewed source/field contract is proven on merged main.
  const foundationProven = architectureFoundationReady(queue, records);
  const foundationDependents = new Set(queue.dispatch_rules?.architecture_foundation_dependent_task_ids || []);
  for (const task of queue.tasks) {
    if (!gateProven && !gateAllowed.has(task.id)) continue;
    if (!foundationProven && foundationDependents.has(task.id)) continue;
    if (!approved(task) || records[task.id]?.conversation_ref || (records[task.id]?.status && records[task.id].status !== "proposed")) continue;
    if (!editableFiles(task).length || editableFiles(task).some(path => claimed.has(path))) continue;
    const openDeps = [];
    let blocked = false;
    for (const dep of task.depends_on) {
      const previous = records[dep];
      if (dep === queue.dispatch_rules?.architecture_foundation_proof_task && foundationProven) continue;
      if (integrated(dep, tasks, records)) continue;
      // A verified open upstream PR can be draft OR ready-for-review.
      // Require a real PR number: an assigned branch name alone is not an open PR.
      if (["draft_open", "review_fixing"].includes(previous?.status) &&
          previous?.github_state === "open" && previous?.branch &&
          Number.isInteger(previous?.pr_number))
        openDeps.push({ ...previous, dependency_id: dep });
      else { blocked = true; break; }
    }
    if (blocked) continue;
    // One GitHub PR can have only one base branch. For a fan-in DAG, the approved
    // queue explicitly selects an open predecessor to stack on. Every other
    // unproven dependency stays a required merge/integration blocker.
    const base = openDeps.length > 1
      ? openDeps.find(x => x.dependency_id === task.stack_base_task && Number.isInteger(x.pr_number))
      : openDeps[0];
    if (openDeps.length > 1 && !base) continue;
    // Claude is reserved for completely independent tasks; no stacked or historic prerequisites.
    const agent = Object.keys(remaining).find(k => remaining[k] > 0 && (k !== "claude" || task.depends_on.length === 0));
    if (!agent) break;
    remaining[agent]--;
    for (const path of editableFiles(task)) claimed.add(path);
    const resolved = resolveTaskBase(task,records);
    if (resolved.blocked) { remaining[agent]++; continue; }
    actions.push({ type: "assign", task_id: task.id, agent,
      base_branch: base?.branch || resolved.base_branch,
      prerequisite_pr: base?.pr_number ?? resolved.prerequisite_pr });
  }
  return actions;
}
export function actionKey(record, action) {
  // Keep the deployed five-part key for unchanged work. Migrating every
  // existing key would re-send previously submitted continuations.
  const committed = record.last_commit_at || record.last_github_activity || "start";
  const parts = [record.task_id, action, record.head_sha || "pre-pr",
    record.prompt_version || "v1", committed];
  const legacyKey = parts.map(s => encodeURIComponent(String(s))).join(":");
  const activity = Date.parse(record.last_github_activity || "");
  const after = Date.parse(record.last_submission_at || "");
  const code = Date.parse(committed);
  // A newly observed PR comment/decision after BOTH code and last courier send
  // gets one activity-qualified continuation. Never change that key back to
  // the legacy key when the courier receipt advances last_submission_at:
  // that would queue the same prompt again without any GitHub change.
  if (Number.isFinite(activity) &&
      (!Number.isFinite(code) || activity > code) &&
      (!Number.isFinite(after) || activity > after))
    return legacyKey + ":" + encodeURIComponent(record.last_github_activity);
  const prior = record.last_action_key;
  if (typeof prior === "string" && prior.startsWith(legacyKey + ":"))
    return prior;
  return legacyKey;
}
// Shared progress is written only by the coordinator, after merge, in its own
// conflict-checked PR. Concurrent implementation PRs may read but never edit it.
export function progressUpdatePolicy(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.some(p=>typeof p!=="string"))
    return { allowed:false, reason:"invalid_changed_paths" };
  if (changedPaths.includes("PROGRESS.md") && changedPaths.length !== 1)
    return { allowed:false, reason:"progress_requires_dedicated_coordination_change" };
  return { allowed:true };
}

// Existing GitHub tick: if Muse found a chat busy, a still-planned action
// needs another wake-up without changing its action ID, hash or permission.
export function wakePendingActions(state, nowMs, intervalMs = 900000) {
  for (const action of Object.values(state.actions || {})) {
    if (action.status !== 'planned' || action.delivery_owner !== 'muse') continue;
    const since = Date.parse(action.last_wake_at || action.created_at || '');
    if (!Number.isFinite(since) || nowMs - since < intervalMs) continue;
    action.last_wake_at = new Date(nowMs).toISOString();
    action.wake_round = (action.wake_round || 0) + 1;
  }
  return state;
}
// Exactly one actionable reason for each quiet-PR continuation. All messages
// are built by delivery.mjs; this pure selector never asks a courier to guess.
export function decideNudge(record, nowMs, { quietMs = 600000, prePrMs = 900000 } = {}) {
  if (!record || !record.approved || !record.conversation_ref)
    return {kind:'hold',reason:'unapproved_or_missing_chat'};
  if (['uncertain','needs_login'].includes(record.submission_state))
    return {kind:'hold',reason:record.submission_state};
  const isPr = Number.isInteger(record.pr_number);
  if (record.agent === 'claude') return {kind:'hold',reason:'claude_no_routine_nudges'};
  if (!isPr && record.browser_busy === true)
    return {kind:'hold',reason:'browser_confirmed_busy'};
  if ((record.owner_question || record.github_owner_question) && !isPr)
    return {kind:'hold',reason:'owner_decision_required'};
  if (isPr && !record.draft && (record.owner_question || record.github_owner_question) &&
      record.ci_state !== 'failure' && record.codex_state !== 'findings' &&
      !record.owner_answer_text) return {kind:'hold',reason:'owner_decision_required'};
  const reviewAt = record.codex_state === 'findings' ? Date.parse(record.codex_review_at || '') : NaN;
  const commitAt = Date.parse(isPr ? record.last_commit_at : record.last_submission_at);
  const last = Number.isFinite(reviewAt) ? Math.max(commitAt,reviewAt) : commitAt;
  const quietFor = nowMs - last;
  if (isPr && !record.draft &&
      (record.ci_state === 'pending' || record.ci_state === 'unknown' ||
       record.codex_state === 'pending' || record.codex_state === 'unknown') &&
      Number.isFinite(quietFor) && quietFor < 900000)
    return {kind:'hold',reason:'checks_pending_or_unknown'};
  if (!Number.isFinite(last) || quietFor < (isPr ? quietMs : prePrMs))
    return {kind:'hold',reason:'not_quiet'};
  const sentMs = Date.parse(record.last_submission_at || '');
  if (record.submission_state === 'submitted' && Number.isFinite(sentMs) &&
      nowMs - sentMs < 900000) return {kind:'hold',reason:'post_delivery_quiet'};
  if (record.next_check_at && nowMs < Date.parse(record.next_check_at))
    return {kind:'hold',reason:'cooldown'};
  if (record.submission_state === 'pending')
    return {kind:'hold',reason:'delivery_pending'};
  // A merged parent gets one stable rebase action regardless of intermediate child pushes.
  const parentSha = record.parent_merged_sha;
  const rebaseDue = isPr && parentSha && record.base_branch === 'main' &&
    record.branch_maintenance_merge_sha === parentSha &&
    record.last_parent_rebase_sha !== parentSha;
  if (rebaseDue) return {kind:'propose',action:'parent_merged',
    key:'parent_merged:'+encodeURIComponent(record.task_id)+':'+parentSha};
  if (isPr && record.parent_merged_sha &&
      record.last_parent_rebase_sha === record.parent_merged_sha &&
      record.base_branch !== 'main')
    return {kind:'hold',reason:'parent_rebase_already_notified'};
  if (isPr && record.waiting_only_for_parent && record.ci_state !== 'failure' &&
      record.codex_state !== 'findings')
    return {kind:'hold',reason:'parent_open_work_already_done'};
  if (isPr && !record.draft && record.ci_state === 'success' &&
      record.codex_state === 'clean' && record.codex_reviewed_sha === record.head_sha &&
      record.acceptance_proven === true && Boolean(record.acceptance_evidence) &&
      record.threads_resolved !== false &&
      record.base_current !== false && record.review_base_current !== false)
    return {kind:'hold',reason:'no_actionable_findings'};
  const action = !isPr ? 'pre_pr_reminder' :
    record.ci_state === 'failure' ? 'ci_failed' :
    record.codex_state === 'findings' ? 'codex_comments' :
    record.owner_answer_text && (!record.owner_answer_key || record.last_owner_answer_key !== record.owner_answer_key)
      ? 'owner_answered' : 'idle_continue';
  let key = actionKey(record,action);
  if (record.last_action_key === key && record.submission_state === 'submitted' &&
      Number.isFinite(sentMs)) {
    // A retry ID has ONE bounded suffix, never recursively grows after sends.
    const committed = record.last_commit_at || record.last_github_activity || 'start';
    const root = [record.task_id,action,record.head_sha || 'pre-pr',
      record.prompt_version || 'v1',committed]
      .map(value=>encodeURIComponent(String(value))).join(':');
    key = root + ':retry:' + encodeURIComponent(record.last_submission_at);
  }
  if (record.last_action_key === key || record.attempts >= (record.max_attempts ?? 3))
    return {kind:'hold',reason:'already_sent_or_capped'};
  return {kind:'propose',action,key};
}

export function readyGate(record, predecessors = []) {
  const reasons=[];
  if (!record?.approved) reasons.push('not_approved');
  if (record?.draft !== true) reasons.push('not_a_draft');
  if (!record?.coder_done) reasons.push('coder_not_done');
  if (record?.ci_state !== 'success') reasons.push('ci_not_green');
  if (record?.owner_question || record?.github_owner_question) reasons.push('owner_decision_pending');
  if (record?.base_branch !== 'main') reasons.push('parent_not_merged_or_rebased');
  if (!record?.base_current) reasons.push('stale_base');
  if (record?.threads_resolved === false) reasons.push('unresolved_threads');
  if (!record?.acceptance_proven) reasons.push('acceptance_not_proven');
  if (predecessors.some(p => !['integrated_proven','released_proven'].includes(p.status)))
    reasons.push('predecessor_not_proven');
  return {eligible:reasons.length===0,reasons};
}
export function invalidateOnHeadChange(record, newSha, at) {
  if (record.head_sha === newSha) return record;
  return { ...record, head_sha: newSha, last_github_activity: at,
    ci_state: "pending", codex_state: "pending", codex_reviewed_sha: null, last_commit_at: at,
    next_check_at: null, last_action_key: null,
    submission_state: record.submission_state === "uncertain" ? "uncertain" : "idle" };
}
export function mergeGate(record, predecessors = []) {
  const reasons = [];
  if (!record?.approved) reasons.push("not_approved");
  // A coding-scope approval never authorizes unresolved owner questions.
  if (record?.owner_question || record?.github_owner_question)
    reasons.push("owner_decision_pending");
  if (record?.draft !== false) reasons.push("not_ready_for_review");
  if (!record?.pr_number || !record?.head_sha) reasons.push("missing_pr_or_sha");
  if (record?.ci_state !== "success") reasons.push("ci_not_green");
  if (record?.codex_state !== "clean" || !record?.codex_reviewed_sha) reasons.push("codex_review_missing_or_findings");
  if (!record?.threads_resolved) reasons.push("unresolved_threads");
  if (record?.base_branch !== "main") reasons.push("non_main_destination");
  if (!record?.base_current) reasons.push("stale_base");
  if (record?.review_base_current === false) reasons.push("base_changed_review_required");
  if (!record?.acceptance_proven) reasons.push("acceptance_not_proven");
  if (predecessors.some(p => p.status !== "integrated_proven" && p.status !== "released_proven")) reasons.push("predecessor_not_proven");
  return { eligible: reasons.length === 0, reasons };
}

export function reconcileGithub(state, openPrs, closedByPr = {}, now = new Date().toISOString()) {
  const copy = structuredClone(state);
  const open = new Set(openPrs.map(p => p.pr_number));
  for (const [id, rec] of Object.entries(copy.tasks)) {
    if (!Number.isInteger(rec.pr_number)) continue;
    if (!open.has(rec.pr_number)) {
      const closed = closedByPr[rec.pr_number];
      const merged = closed === true || closed?.merged === true;
      copy.tasks[id] = { ...rec, github_owner_question: merged ? null : rec.github_owner_question,
        github_state: merged ? "merged" : "not_open_unverified",
        merge_sha: merged ? (closed?.merge_sha || rec.merge_sha || null) : rec.merge_sha,
        status: merged && !["integrated_proven", "released_proven"].includes(rec.status) ? "merged" : rec.status };
    }
  }
  for (const pr of openPrs) {
    for (const [id, rec] of Object.entries(copy.tasks)) {
      if (rec.pr_number !== pr.pr_number) continue;
      if (rec.head_sha !== pr.head_sha) {
        for (const action of Object.values(copy.actions)) {
          if (action.task_id === id && action.status === "planned" &&
              action.type !== 'parent_merged' && action.head_sha !== pr.head_sha) {
            action.status = "cancelled_stale_head";
          }
        }
      }
      const updated = invalidateOnHeadChange(rec, pr.head_sha, pr.last_commit_at || pr.last_github_activity);
      const baseChanged = Boolean(rec.base_sha && pr.base_sha && rec.base_sha !== pr.base_sha);
      const baseChangedAt = baseChanged ? now : rec.base_changed_at;
      const reviewBaseCurrent = !baseChangedAt || Boolean(pr.codex_review_at &&
        Date.parse(pr.codex_review_at) > Date.parse(baseChangedAt));
      copy.tasks[id] = { ...updated, ...pr, task_id: id,
        base_changed_at: baseChangedAt || null, review_base_current: reviewBaseCurrent,
        status: (pr.github_owner_question || updated.owner_question) ? "blocked_needs_owner" :
          pr.draft ? "draft_open" : "review_fixing", github_state: "open",
        submission_state: updated.submission_state };
    }
  }
  return copy;
}
