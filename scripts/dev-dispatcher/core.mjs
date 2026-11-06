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
  return tasks;
}
export const approved = (task) => task.architecture_approval?.approved === true && (task.state === "architecture_approved" || task.state === "ready");
export function integrated(taskId, tasks, records) {
  const task = tasks.get(taskId);
  if (!task) return false; // historic merges must have explicit durable proof records
  const rec = records[taskId];
  return rec?.status === "integrated_proven" || rec?.status === "released_proven";
}
export function dispatchFrontier(queue, records = {}, capacity = { chatgpt: 4, claude: 2 }) {
  const tasks = validateQueue(queue);
  const remaining = { ...capacity };
  for (const r of Object.values(records)) {
    if (r.status === "assigned" || r.status === "draft_open" || r.status === "review_fixing") {
      if (r.agent in remaining) remaining[r.agent] = Math.max(0, remaining[r.agent] - 1);
    }
  }
  const claimed = new Set();
  for (const [id, record] of Object.entries(records)) {
    if (["assigned", "draft_open", "review_fixing"].includes(record.status)) {
      for (const path of tasks.get(id)?.exclusive_files || []) claimed.add(path);
    }
  }
  const actions = [];
  for (const task of queue.tasks) {
    if (!approved(task) || records[task.id]?.conversation_ref || (records[task.id]?.status && records[task.id].status !== "proposed")) continue;
    if (!Array.isArray(task.exclusive_files) || !task.exclusive_files.length ||
      task.exclusive_files.some(path => typeof path !== "string" || !path || path.includes("*") || path.includes("..") || claimed.has(path))) continue;
    const openDeps = [];
    let blocked = false;
    for (const dep of task.depends_on) {
      const previous = records[dep];
      if (integrated(dep, tasks, records)) continue;
      if (previous?.status === "draft_open" && previous?.branch) openDeps.push(previous);
      else { blocked = true; break; }
    }
    if (blocked || openDeps.length > 1) continue; // multi-branch stacks require explicit integration decision
    const agent = Object.keys(remaining).find(k => remaining[k] > 0);
    if (!agent) break;
    remaining[agent]--;
    for (const path of task.exclusive_files) claimed.add(path);
    actions.push({ type: "assign", task_id: task.id, agent, base_branch: openDeps[0]?.branch || "main",
      prerequisite_pr: openDeps[0]?.pr_number ?? null });
  }
  return actions;
}
export function actionKey(record, action) {
  const parts = [record.task_id, action, record.head_sha || "pre-pr", record.prompt_version || "v1", record.last_github_activity || "start"];
  return parts.map(s => encodeURIComponent(String(s))).join(":");
}
export function decideNudge(record, nowMs, { quietMs = 600000, prePrMs = 1800000 } = {}) {
  if (!record || !record.approved || !record.conversation_ref) return { kind: "hold", reason: "unapproved_or_missing_chat" };
  if (record.submission_state === "uncertain" || record.submission_state === "needs_login") return { kind: "hold", reason: record.submission_state };
  const isPr = Number.isInteger(record.pr_number);
  if (isPr && (record.ci_state === "pending" || record.codex_state === "pending" ||
      record.ci_state === "unknown" || record.codex_state === "unknown")) return { kind: "hold", reason: "checks_pending_or_unknown" };
  if (isPr && (!["success", "failure"].includes(record.ci_state) || !["clean", "findings"].includes(record.codex_state))) return { kind: "hold", reason: "unverified_checks" };
  if (isPr && record.codex_reviewed_sha !== record.head_sha && record.codex_state === "clean") return { kind: "hold", reason: "stale_codex" };
  if (!isPr && record.browser_busy !== false) return { kind: "hold", reason: "busy_or_unknown" };
  const last = Date.parse(isPr ? record.last_github_activity : record.last_submission_at);
  if (!Number.isFinite(last) || nowMs - last < (isPr ? quietMs : prePrMs)) return { kind: "hold", reason: "not_quiet" };
  if (record.next_check_at && nowMs < Date.parse(record.next_check_at)) return { kind: "hold", reason: "cooldown" };
  const action = isPr ? (record.ci_state === "failure" ? "repair_ci" : record.codex_state === "findings" ? "repair_review" : "continue_pr") : "pre_pr_reminder";
  const key = actionKey(record, action);
  if (record.last_action_key === key || record.submission_state === "pending" || record.attempts >= (record.max_attempts ?? 3)) return { kind: "hold", reason: "already_sent_or_capped" };
  return { kind: "propose", action, key };
}
export function invalidateOnHeadChange(record, newSha, at) {
  if (record.head_sha === newSha) return record;
  return { ...record, head_sha: newSha, last_github_activity: at,
    ci_state: "pending", codex_state: "pending", codex_reviewed_sha: null,
    next_check_at: null, last_action_key: null,
    submission_state: record.submission_state === "uncertain" ? "uncertain" : "idle" };
}
export function mergeGate(record, predecessors = []) {
  const reasons = [];
  if (!record?.approved) reasons.push("not_approved");
  if (!record?.pr_number || !record?.head_sha) reasons.push("missing_pr_or_sha");
  if (record?.ci_state !== "success") reasons.push("ci_not_green");
  if (record?.codex_state !== "clean" || record?.codex_reviewed_sha !== record?.head_sha) reasons.push("codex_not_clean_on_head");
  if (!record?.threads_resolved) reasons.push("unresolved_threads");
  if (!record?.base_current) reasons.push("stale_base");
  if (!record?.acceptance_proven) reasons.push("acceptance_not_proven");
  if (predecessors.some(p => p.status !== "integrated_proven" && p.status !== "released_proven")) reasons.push("predecessor_not_proven");
  return { eligible: reasons.length === 0, reasons };
}

export function reconcileGithub(state, openPrs, closedByPr = {}) {
  const copy = structuredClone(state);
  const open = new Set(openPrs.map(p => p.pr_number));
  for (const [id, rec] of Object.entries(copy.tasks)) {
    if (!Number.isInteger(rec.pr_number)) continue;
    if (!open.has(rec.pr_number)) {
      const merged = closedByPr[rec.pr_number] === true;
      copy.tasks[id] = { ...rec, github_state: merged ? "merged" : "not_open_unverified",
        status: merged && rec.status !== "integrated_proven" ? "merged" : rec.status };
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
      const updated = invalidateOnHeadChange(rec, pr.head_sha, pr.last_github_activity);
      copy.tasks[id] = { ...updated, ...pr, task_id: id, github_state: "open",
        submission_state: updated.submission_state };
    }
  }
  return copy;
}
