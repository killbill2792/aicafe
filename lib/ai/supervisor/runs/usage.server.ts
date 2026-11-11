import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Caps come from authenticated server configuration, never a model reply.
 * A cap of zero denies new work; usage is measured across the whole run. */
export type WorkerBudget = Readonly<{
  maxElapsedMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export type WorkerUsage = Readonly<{
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}>;

export type UsageStopReason = "timeout" | "budget" | null;

export function usageStopReason(usage: WorkerUsage, cap: WorkerBudget): UsageStopReason {
  for (const n of Object.values({ ...usage, ...cap })) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("invalid_supervisor_worker_usage");
  }
  if (usage.elapsedMs >= cap.maxElapsedMs) return "timeout";
  if (usage.modelCalls >= cap.maxModelCalls ||
    usage.toolCalls >= cap.maxToolCalls ||
    usage.inputTokens >= cap.maxInputTokens ||
    usage.outputTokens >= cap.maxOutputTokens) return "budget";
  return null;
}

/** One async-local meter spans every sequential continuation in a durable
 * run. Ordinary browser/WhatsApp conversations never see this meter. */
type WorkerMeter = { cap: WorkerBudget; started: number; used: WorkerUsage };
const workerBudgets = new AsyncLocalStorage<WorkerMeter>();
const FINISH_RESERVE_MS = 3000; // keep time for canonical finish/lease acknowledgement
const empty: WorkerUsage = { elapsedMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };

export function currentWorkerBudget(): WorkerBudget | undefined {
  const meter = workerBudgets.getStore();
  if (!meter) return undefined;
  return {
    maxElapsedMs: Math.max(0, meter.cap.maxElapsedMs -
      Math.max(0, Date.now() - meter.started) - FINISH_RESERVE_MS),
    maxModelCalls: Math.max(0, meter.cap.maxModelCalls - meter.used.modelCalls),
    maxToolCalls: Math.max(0, meter.cap.maxToolCalls - meter.used.toolCalls),
    maxInputTokens: Math.max(0, meter.cap.maxInputTokens - meter.used.inputTokens),
    maxOutputTokens: Math.max(0, meter.cap.maxOutputTokens - meter.used.outputTokens),
  };
}

/** Count each finished one-agent turn before another one may start. Usage is
 * captured even when a provider returns an incomplete/budget-limited answer. */
export function recordWorkerTurnUsage(used: WorkerUsage): void {
  const meter = workerBudgets.getStore();
  if (!meter) return;
  usageStopReason(used, meter.cap); // validate nonnegative safe integers
  for (const key of ["modelCalls", "toolCalls", "inputTokens", "outputTokens"] as const) {
    const next = meter.used[key] + used[key];
    if (!Number.isSafeInteger(next)) throw new Error("invalid_supervisor_worker_usage");
    meter.used = { ...meter.used, [key]: next };
  }
}

export function currentWorkerUsage(): WorkerUsage | undefined {
  const meter = workerBudgets.getStore();
  return meter ? { ...meter.used, elapsedMs: Math.max(0, Date.now() - meter.started) } : undefined;
}
export function workerBudgetExhausted(): UsageStopReason {
  const remaining = currentWorkerBudget();
  return remaining ? usageStopReason(empty, remaining) : null;
}
export async function withWorkerBudget<T>(budget: WorkerBudget, work: () => Promise<T>): Promise<T> {
  if (usageStopReason(empty, budget)) throw new Error("supervisor_worker_budget_exhausted");
  return workerBudgets.run({ cap: budget, started: Date.now(), used: empty }, work);
}
