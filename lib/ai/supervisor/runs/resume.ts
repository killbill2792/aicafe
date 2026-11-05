import type { DurableRunRepository, RunScope, StepClaim } from "./contracts";

type Claimed = Extract<StepClaim, { kind: "claimed" }>;
export type StepExecutor = (step: Claimed, renewLease: () => Promise<boolean>) => Promise<string>;

/** A run's ordered steps have already been registered atomically. Executors MUST
 * use step.idempotencyKey for replay-safe external writes; otherwise their step
 * must be registered with retry:"reconcile" and an expired claim will block.
 * This helper does not replace any approval or chat-job path. */
export async function resumeSupervisorRun(
  repo: DurableRunRepository, scope: RunScope, runId: string, workerId: string,
  leaseSeconds: number, finalReportRef: string, execute: StepExecutor,
): Promise<"completed" | "busy" | "blocked"> {
  for (;;) {
    const claim = await repo.claim(scope, runId, workerId, leaseSeconds);
    if (claim.kind !== "claimed") {
      if (claim.kind === "busy" || claim.kind === "blocked") return claim.kind;
      if (claim.kind === "ready_for_report") {
        await repo.finish(scope, runId, finalReportRef);
      }
      return "completed";
    }
    const renew = () => repo.renew(scope, runId, claim.key, claim.claimToken, leaseSeconds);
    // If the process dies here, a persisted completed step is never revisited.
    // A failed/uncertain effect remains leased until expiry; only key-aware
    // idempotent steps replay automatically.
    const receipt = await execute(claim, renew);
    await repo.complete(scope, runId, claim.key, claim.claimToken, receipt);
  }
}
