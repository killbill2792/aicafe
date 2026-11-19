import english from "@/messages/en.json";

/**
 * Task 16B: owner-visible status from canonical persisted evidence.
 * This module never starts work, approves an effect, or treats a model reply
 * or a tool-progress event as proof of a provider-side action.
 */
export type OwnerWorkStatus =
  | "queued" | "running" | "retrying" | "approval_required"
  | "uncertain" | "failed" | "cancelled" | "answer_ready" | "verified_complete" | "source_resolved";

export type OwnerWorkItem = {
  id: string;
  threadId: string | null;
  threadTitle?: string | null;
  kind: "durable_run" | "agent_turn" | "approval" | "investigation";
  status: OwnerWorkStatus;
  title: string;
  detail: string;
  nextStep: string;
  updatedAt: string;
  ownerMessageId: string | null;
  step: string | null;
  attempt: number | null;
  errorCode: string | null;
  proof: { kind: "verified_reply" | "verified_effect"; ref: string; at: string | null } | null;
  proposalId: string | null;
};

export type RunRow = {
  thread_id?: string | null;
  execution_version?:number;
  id: string; request_key: string; status: "pending" | "running" | "blocked" | "completed";
  final_report_ref: string | null; updated_at: string; finished_at: string | null;
};
export type StepRow = {
  run_id: string; step_key: string; step_index: number; status: "pending" | "leased" | "blocked" | "completed";
  attempts: number; error_code: string | null; updated_at: string;
  retry_mode: "idempotent" | "reconcile"; lease_until: string | null;
  checkpoint_phase?:"ready"|"provider_pending"|"read_pending"|"effect_pending";next_retry_at?:string|null;
};
export type JobRow = {
  thread_id?: string | null;
  id: string; owner_message_id: string; status: "running" | "done" | "failed";
  reply_message_id: string | null; error_code: string | null; attempt: number;
  heartbeat_at: string; created_at: string;
};
export type ProposalRow = {
  thread_id?: string | null;
  id: string; status: string; capability_id: string; effect_hash: string; updated_at: string;
};
export type AttemptRow = {
  proposal_id: string; effect_hash: string; state: string;
  receipt_ref: string | null; verified_at: string | null;
};

export type InvestigationRow = {
  thread_id?: string | null;
  episode_id: string;
  phase: "collect" | "investigate" | "awaiting_owner" | "resolved" | "blocked";
  failure_count: number; lease_token: string | null;
  lease_until: string | null; last_error: string | null; updated_at: string;
};

// All owner-visible phrasing comes from the required English message catalog.
// Never let a server or model-authored work state bypass this locale source.
const copy = english.SupervisorWork.copy;

const stepNames: Record<string, string> = {
  authorize_owner: copy.stepAuthorizeOwner,
  owner_turn: copy.stepOwnerTurn,
  verify_report: copy.stepVerifyReport,
};
export function projectOwnerWork(input: {
  runs: RunRow[]; steps: StepRow[]; jobs: JobRow[];
  proposals: ProposalRow[]; attempts: AttemptRow[]; investigations?: InvestigationRow[];
}, nowMs = Date.now()): OwnerWorkItem[] {
  const work: OwnerWorkItem[] = [];
  const steps = new Map<string, StepRow[]>();
  for (const s of input.steps) steps.set(s.run_id, [...(steps.get(s.run_id) ?? []), s]);
  for (const run of input.runs) {
    const next = (steps.get(run.id) ?? []).sort((a, b) => a.step_index - b.step_index)
      .find(s => s.status !== "completed");
    const expired = run.status === "blocked" && (next?.error_code === "lease_expired"
      || (next?.retry_mode === "reconcile" && ["turn_failed", "turn_incomplete"].includes(next.error_code ?? "")));
    // A leased row can outlive a dead process. Before the next worker tick,
    // do not claim it is working or that an effect is safe to repeat.
    const leaseEnd = next?.lease_until ? Date.parse(next.lease_until) : NaN;
    const staleLease = next?.status === "leased" && (!Number.isFinite(leaseEnd) || leaseEnd <= nowMs);
    const waiting=run.execution_version===2&&run.status==="blocked"&&next?.error_code==="awaiting_owner";
    const cancelled=run.status==="blocked"&&next?.error_code==="cancelled";
    const safeRetry=run.execution_version===2&&next?.checkpoint_phase!==undefined&&next.checkpoint_phase!=="effect_pending";
    const status: OwnerWorkStatus = waiting?"approval_required":cancelled?"cancelled":run.status === "pending" ? (next?.next_retry_at?"retrying":"queued")
      : run.status === "completed" && run.final_report_ref ? "answer_ready"
      : run.status === "completed" ? "uncertain"
      : run.status === "blocked" ? expired ? "uncertain" : "failed"
      : staleLease ? (safeRetry?"retrying":next?.retry_mode === "idempotent" ? "queued" : "uncertain")
      : next?.status === "leased" && next.attempts > 1 ? "retrying" : "running";
    work.push({
      id: "run:" + run.id, threadId: run.thread_id ?? null, kind: "durable_run", status, title: copy.runTitle,
      detail: waiting?copy.runAwaitingOwner:cancelled?copy.runCancelled:status === "retrying"?copy.runRetrying:status === "answer_ready"
        ? copy.runAnswerReady
        : status === "uncertain" ? copy.runUncertain
        : status === "failed" ? copy.runFailed
        : status === "queued" ? copy.runQueued
        : next ? (stepNames[next.step_key] ?? copy.runGeneric)
        : copy.runChecking,
      nextStep: waiting?copy.runAwaitingOwnerNext:cancelled?copy.runCancelled:status === "uncertain" ? copy.runUncertainNext
        : status === "failed" ? copy.runFailedNext
        : status === "answer_ready" ? copy.runAnswerNext
        : copy.runActiveNext,
      updatedAt: run.updated_at, ownerMessageId: run.request_key,
      step: next?.step_key ?? null, attempt: next?.attempts ?? null,
      errorCode: next?.error_code ?? null,
      proof: status === "answer_ready" && run.final_report_ref
        ? { kind: "verified_reply", ref: run.final_report_ref, at: run.finished_at } : null,
      proposalId: null,
    });
  }
  const ownerRuns = new Set(input.runs.map(run => (run.thread_id ?? "") + ":" + run.request_key));
  for (const job of input.jobs) {
    // The durable run already represents this same owner turn. Never show a
    // second status card for the underlying per-turn job.
    if (ownerRuns.has((job.thread_id ?? "") + ":" + job.owner_message_id)) continue;
    // A missing heartbeat is UNKNOWN, not proof the worker failed or the
    // external effect was rolled back. The durable run/receipt may still exist.
    const heartbeat = Date.parse(job.heartbeat_at);
    const stale = job.status === "running" &&
      (!Number.isFinite(heartbeat) || nowMs - heartbeat > 180_000);
    const status: OwnerWorkStatus = job.status === "done" && job.reply_message_id
      ? "answer_ready" : job.status === "done" ? "uncertain"
      : job.status === "failed" ? "failed"
      : stale ? "uncertain" : job.attempt > 1 ? "retrying" : "running";
    work.push({
      id: "job:" + job.id, threadId: job.thread_id ?? null, kind: "agent_turn", status,
      title: copy.jobTitle,
      detail: status === "answer_ready" ? copy.jobAnswerReady
        : stale ? copy.jobStale
        : status === "failed" ? copy.jobFailed
        : copy.jobRunning,
      nextStep: stale ? copy.jobStaleNext
        : status === "failed" ? copy.jobFailedNext
        : status === "answer_ready" ? copy.jobAnswerNext
        : copy.jobActiveNext,
      updatedAt: job.heartbeat_at || job.created_at, ownerMessageId: job.owner_message_id,
      step: null, attempt: job.attempt, errorCode: job.error_code,
      proof: status === "answer_ready" && job.reply_message_id
        ? { kind: "verified_reply", ref: job.reply_message_id, at: null } : null,
      proposalId: null,
    });
  }
  // 15A persisted investigations are scoped by the same owner and thread.
  // Closing a source incident never proves an external supplier/staff effect.
  for (const inv of input.investigations ?? []) {
    const leased = !!inv.lease_token && !!inv.lease_until && Date.parse(inv.lease_until) > nowMs;
    const missing = ["source_missing", "source_reassigned"].includes(inv.last_error ?? "");
    const status: OwnerWorkStatus = inv.phase === "resolved" ? "source_resolved"
      : inv.phase === "blocked" ? (missing ? "uncertain" : "failed")
      : inv.failure_count > 0 && !leased ? "retrying"
      : inv.phase === "collect" && !leased ? "queued" : "running";
    work.push({
      id: "investigation:" + inv.episode_id, threadId: inv.thread_id ?? null, kind: "investigation", status,
      title: copy.investigationTitle,
      detail: status === "source_resolved" ? copy.investigationResolved
        : missing ? copy.investigationUncertain
        : status === "failed" ? copy.investigationFailed
        : status === "retrying" ? copy.investigationRetrying
        : status === "queued" ? copy.investigationQueued
        : inv.phase === "awaiting_owner" ? copy.investigationWatching : copy.investigationRunning,
      nextStep: copy.investigationNext, updatedAt: inv.updated_at,
      ownerMessageId: null, step: inv.phase, attempt: inv.failure_count || null,
      errorCode: inv.last_error, proof: null, proposalId: null,
    });
  }
  const attempts = new Map(input.attempts.map(a => [a.proposal_id + ":" + a.effect_hash, a]));
  for (const p of input.proposals) {
    const effect = attempts.get(p.id + ":" + p.effect_hash);
    const hasReceipt = effect?.state === "verified" && !!effect.receipt_ref && !!effect.verified_at;
    const succeeded = ["committed", "monitored", "manual_confirmed"].includes(p.status);
    const status: OwnerWorkStatus = p.status === "draft" ? "approval_required"
      : effect?.state === "uncertain" || (succeeded && !hasReceipt) ? "uncertain"
      : succeeded && hasReceipt ? "verified_complete"
      : ["rejected", "expired"].includes(p.status) ? "cancelled"
      : p.status === "stale" ? "failed"
      : p.status === "manual_pending" ? "uncertain" : "running";
    work.push({
      id: "proposal:" + p.id, threadId: p.thread_id ?? null, kind: "approval", status,
      title: copy.proposalTitle,
      detail: status === "approval_required" ? copy.proposalDraft
        : status === "verified_complete" ? copy.proposalVerified
        : status === "uncertain" ? copy.proposalUncertain
        : status === "cancelled" ? copy.proposalCancelled
        : status === "failed" ? copy.proposalFailed
        : copy.proposalExecuting,
      nextStep: status === "approval_required"
        ? copy.proposalDraftNext
        : status === "verified_complete" ? copy.proposalVerifiedNext
        : status === "uncertain" ? copy.proposalUncertainNext
        : status === "cancelled" ? copy.proposalCancelledNext
        : status === "failed" ? copy.proposalFailedNext
        : copy.proposalExecutingNext,
      updatedAt: p.updated_at, ownerMessageId: null,
      step: null, attempt: null, errorCode: null, proposalId: p.id,
      proof: status === "verified_complete" && effect?.receipt_ref && effect.verified_at
        ? { kind: "verified_effect", ref: effect.receipt_ref, at: effect.verified_at } : null,
    });
  }
  const priority = (s: OwnerWorkStatus) =>
    ["uncertain", "failed", "approval_required", "retrying", "running", "queued", "verified_complete", "answer_ready", "source_resolved", "cancelled"].indexOf(s);
  const sorted = work.sort((a, b) => priority(a.status) - priority(b.status)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    || a.id.localeCompare(b.id));
  const settled = (s: OwnerWorkStatus) =>
    ["verified_complete","answer_ready","source_resolved","cancelled"].includes(s);
  // Keep ALL unresolved work addressable; only confirmed past results are bounded.
  return [...sorted.filter(x => !settled(x.status)), ...sorted.filter(x => settled(x.status)).slice(0,2)];
}
