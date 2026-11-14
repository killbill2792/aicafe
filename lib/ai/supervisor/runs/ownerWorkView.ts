import english from "@/messages/en.json";

/**
 * Task 16B: owner-visible status from canonical persisted evidence.
 * This module never starts work, approves an effect, or treats a model reply
 * or a tool-progress event as proof of a provider-side action.
 */
export type OwnerWorkStatus =
  | "queued" | "running" | "retrying" | "approval_required"
  | "uncertain" | "failed" | "cancelled" | "answer_ready" | "verified_complete";

export type OwnerWorkItem = {
  id: string;
  kind: "durable_run" | "agent_turn" | "approval";
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
  id: string; request_key: string; status: "pending" | "running" | "blocked" | "completed";
  final_report_ref: string | null; updated_at: string; finished_at: string | null;
};
export type StepRow = {
  run_id: string; step_key: string; step_index: number; status: "pending" | "leased" | "blocked" | "completed";
  attempts: number; error_code: string | null; updated_at: string;
};
export type JobRow = {
  id: string; owner_message_id: string; status: "running" | "done" | "failed";
  reply_message_id: string | null; error_code: string | null; attempt: number;
  heartbeat_at: string; created_at: string;
};
export type ProposalRow = {
  id: string; status: string; capability_id: string; effect_hash: string; updated_at: string;
};
export type AttemptRow = {
  proposal_id: string; effect_hash: string; state: string;
  receipt_ref: string | null; verified_at: string | null;
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
  proposals: ProposalRow[]; attempts: AttemptRow[];
}, nowMs = Date.now()): OwnerWorkItem[] {
  const work: OwnerWorkItem[] = [];
  const steps = new Map<string, StepRow[]>();
  for (const s of input.steps) steps.set(s.run_id, [...(steps.get(s.run_id) ?? []), s]);
  for (const run of input.runs) {
    const next = (steps.get(run.id) ?? []).sort((a, b) => a.step_index - b.step_index)
      .find(s => s.status !== "completed");
    const expired = run.status === "blocked" && next?.error_code === "lease_expired";
    const status: OwnerWorkStatus = run.status === "pending" ? "queued"
      : run.status === "completed" && run.final_report_ref ? "answer_ready"
      : run.status === "completed" ? "uncertain"
      : run.status === "blocked" ? expired ? "uncertain" : "failed"
      : next?.status === "leased" && next.attempts > 1 ? "retrying" : "running";
    work.push({
      id: "run:" + run.id, kind: "durable_run", status, title: copy.runTitle,
      detail: status === "answer_ready"
        ? copy.runAnswerReady
        : status === "uncertain" ? copy.runUncertain
        : status === "failed" ? copy.runFailed
        : status === "queued" ? copy.runQueued
        : next ? (stepNames[next.step_key] ?? copy.runGeneric)
        : copy.runChecking,
      nextStep: status === "uncertain" ? copy.runUncertainNext
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
  const ownerRuns = new Set(input.runs.map(run => run.request_key));
  for (const job of input.jobs) {
    // The durable run already represents this same owner turn. Never show a
    // second status card for the underlying per-turn job.
    if (ownerRuns.has(job.owner_message_id)) continue;
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
      id: "job:" + job.id, kind: "agent_turn", status,
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
      id: "proposal:" + p.id, kind: "approval", status,
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
    ["uncertain", "failed", "approval_required", "retrying", "running", "queued", "verified_complete", "answer_ready", "cancelled"].indexOf(s);
  return work.sort((a, b) => priority(a.status) - priority(b.status)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    || a.id.localeCompare(b.id)).slice(0, 18);
}
