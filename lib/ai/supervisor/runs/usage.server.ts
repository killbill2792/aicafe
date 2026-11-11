import "server-only";

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
