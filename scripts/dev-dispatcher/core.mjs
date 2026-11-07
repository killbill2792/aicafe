// AI CAFE developer dispatcher: pure, deterministic decisions. No browser, LLM or merge effects.
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const taskKey = (id) => {
  if (!ID.test(id)) throw new Error("Invalid task id");
  return `aicafe:${id}`;
};
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
      for (const path of tasks.get(id)?.exclusive_files || []) claimed.add(path);
    }
  }
  const actions = [];
  const gate = queue.dispatch_rules?.priority_gate_task;
  const gateProven = !gate || integrated(gate, tasks, records);
  const gateAllowed = new Set(queue.dispatch_rules?.priority_gate_allow_task_ids || []);
  for (const task of queue.tasks) {
    if (!gateProven && !gateAllowed.has(task.id)) continue;
    if (!approved(task) || records[task.id]?.conversation_ref || (records[task.id]?.status && records[task.id].status !== "proposed")) continue;
    if (!Array.isArray(task.exclusive_files) || !task.exclusive_files.length ||
      task.exclusive_files.some(path => typeof path !== "string" || !path || path.includes("*") || path.includes("..") || claimed.has(path))) continue;
    const openDeps = [];
    let blocked = false;
    for (const dep of task.depends_on) {
      const previous = records[dep];
      if (integrated(dep, tasks, records)) continue;
      if (previous?.status === "draft_open" && previous?.branch)
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
    for (const path of task.exclusive_files) claimed.add(path);
    actions.push({ type: "assign", task_id: task.id, agent, base_branch: base?.branch || "main",
      prerequisite_pr: base?.pr_number ?? null });
  }
  return actions;
}
export function actionKey(record, action) {
  const parts = [record.task_id, action, record.head_sha || "pre-pr", record.prompt_version || "v1", record.last_commit_at || record.last_github_activity || "start"];
  return parts.map(s => encodeURIComponent(String(s))).join(":");
}
export function decideNudge(record, nowMs, { quietMs = 600000, prePrMs = 900000 } = {}) {
  if (!record || !record.approved || !record.conversation_ref) return { kind: "hold", reason: "unapproved_or_missing_chat" };
  if (record.submission_state === "uncertain" || record.submission_state === "needs_login") return { kind: "hold", reason: record.submission_state };
  if (record.owner_question || record.github_owner_question) return {kind:"hold",reason:"owner_decision_required"};
  const isPr = Number.isInteger(record.pr_number);
  if (isPr && (record.ci_state === "pending" || record.codex_state === "pending" ||
      record.ci_state === "unknown" || record.codex_state === "unknown")) return { kind: "hold", reason: "checks_pending_or_unknown" };
  if (isPr && (!["success", "failure"].includes(record.ci_state) || !["clean", "findings"].includes(record.codex_state))) return { kind: "hold", reason: "unverified_checks" };
  if (record.agent === "claude") return { kind: "hold", reason: "claude_no_routine_nudges" };
  // GitHub cannot see the browser. Muse checks actual composer activity before any reminder.
  if (!isPr && record.browser_busy === true) return { kind: "hold", reason: "browser_confirmed_busy" };
  if (isPr && record.draft) return { kind: "hold", reason: "draft_not_ready" };
  const last = Date.parse(isPr ? (record.codex_state === "findings" && record.codex_review_at && Date.parse(record.codex_review_at) > Date.parse(record.last_commit_at || 0) ? record.codex_review_at : record.last_commit_at) : record.last_submission_at);
  if (!Number.isFinite(last) || nowMs - last < (isPr ? quietMs : prePrMs)) return { kind: "hold", reason: "not_quiet" };
  if (record.next_check_at && nowMs < Date.parse(record.next_check_at)) return { kind: "hold", reason: "cooldown" };
  // No generic reminder for an already reviewed PR with captured acceptance proof.
  // Otherwise, a stalled ready PR may still need evidence, thread or base repairs.
  if (isPr && record.ci_state === "success" && record.codex_state === "clean" &&
      record.acceptance_evidence && record.threads_resolved !== false &&
      record.base_current !== false && record.review_base_current !== false)
    return { kind: "hold", reason: "no_actionable_findings" };
  const action = isPr ? (record.ci_state === "failure" ? "repair_ci" :
    record.codex_state === "findings" ? "repair_review" : "continue_pr") : "pre_pr_reminder";
  const key = actionKey(record, action);
  if (record.last_action_key === key || record.submission_state === "pending" || record.attempts >= (record.max_attempts ?? 3)) return { kind: "hold", reason: "already_sent_or_capped" };
  return { kind: "propose", action, key };
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
          if (action.task_id === id && action.status === "planned" && action.head_sha !== pr.head_sha) {
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
