import { z } from "zod";

export const runScopeSchema = z.strictObject({
  businessId: z.uuid(), ownerUserId: z.uuid(), threadId: z.uuid(),
});
export type RunScope = z.infer<typeof runScopeSchema>;

export const stepSpecSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_:-]{0,79}$/u),
  // A timed-out external effect is never blindly replayed.
  // "idempotent" is only for executors that honor the supplied stable key.
  retry: z.enum(["idempotent", "reconcile"]),
});
export type StepSpec = z.infer<typeof stepSpecSchema>;

const runRowSchema = z.object({
  id: z.uuid(), business_id: z.uuid(), owner_user_id: z.uuid(),
  thread_id: z.uuid(), request_key: z.uuid(), plan_hash: z.string().length(64),
  status: z.enum(["pending", "running", "blocked", "completed"]),
  final_report_ref: z.string().nullable(),
});
export type DurableRun = {
  id: string; businessId: string; ownerUserId: string; threadId: string;
  requestKey: string; status: "pending" | "running" | "blocked" | "completed";
  finalReportRef: string | null;
};
export function decodeRun(row: unknown): DurableRun {
  const r = runRowSchema.parse(row);
  return {
    id: r.id, businessId: r.business_id, ownerUserId: r.owner_user_id,
    threadId: r.thread_id, requestKey: r.request_key,
    status: r.status, finalReportRef: r.final_report_ref,
  };
}

const claimedSchema = z.object({
  kind: z.literal("claimed"),
  idempotency_key: z.string().min(1),
  step: z.object({
    step_key: z.string(), retry_mode: z.enum(["idempotent", "reconcile"]),
    claim_token: z.uuid(), lease_until: z.string(), attempts: z.number().int().positive(),
  }),
});
const claimSchema = z.discriminatedUnion("kind", [
  claimedSchema,
  z.object({ kind: z.literal("busy") }),
  z.object({ kind: z.literal("blocked") }),
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("ready_for_report") }),
]);
export type StepClaim =
  | { kind: "claimed"; key: string; retry: StepSpec["retry"];
      claimToken: string; leaseUntil: string; attempt: number; idempotencyKey: string }
  | { kind: "busy" | "blocked" | "completed" | "ready_for_report" };
export function decodeClaim(value: unknown): StepClaim {
  const r = claimSchema.parse(value);
  if (r.kind !== "claimed") return { kind: r.kind };
  return {
    kind: "claimed", key: r.step.step_key, retry: r.step.retry_mode,
    claimToken: r.step.claim_token, leaseUntil: r.step.lease_until,
    attempt: r.step.attempts, idempotencyKey: r.idempotency_key,
  };
}

export interface DurableRunRepository {
  start(scope: RunScope, requestKey: string, steps: readonly StepSpec[]): Promise<DurableRun>;
  claim(scope: RunScope, runId: string, workerId: string, leaseSeconds: number): Promise<StepClaim>;
  renew(scope: RunScope, runId: string, key: string, token: string, leaseSeconds: number): Promise<boolean>;
  complete(scope: RunScope, runId: string, key: string, token: string, resultRef: string): Promise<void>;
  // Caller must first verify the receipt against the canonical effect ledger.
  reconcile(scope: RunScope, runId: string, key: string, verifiedResultRef: string): Promise<void>;
  finish(scope: RunScope, runId: string, finalReportRef: string): Promise<DurableRun>;
}
