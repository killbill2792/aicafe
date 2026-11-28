import "server-only";
import { z } from "zod";
import type { AgentProvider, AgentTurn } from "@/lib/ai/agent/loop.server";
import type { ResearchContinuationPort, RunScope } from "@/lib/ai/supervisor/runs/contracts";
import {
  advanceAssignmentProvider, assertLunaPaidAcceptanceAllowed, assignmentReadRequest, parseSavedProviderResponse, readAssignmentEvidence, runAssignmentReadLoop,
  type AssignmentProviderPort, type ProviderCheckpoint, type ProviderRequest, type SavedProviderResponse,
} from "@/lib/luna/runtime/assignment-provider.server";
import { assignmentReadTools, assignmentTextBlocks } from "@/lib/luna/runtime/assignment-worker.server";

const checkpointState = z.object({
  version: z.literal(1),
  checkpoint: z.object({
    phase: z.enum(["ready", "provider_pending", "read_pending"]),
    sequence: z.number().int().nonnegative(), operation: z.uuid().nullable(), lastReceipt: z.string().nullable(),
  }),
  result: z.unknown(),
});

export async function runLunaScheduledResearch({ scope, continuation, request, reserve, provider, authorize,
  executionDeadline, budget }: {
  scope: RunScope; continuation: ResearchContinuationPort & { yield: () => Promise<void> };
  request: ProviderRequest; reserve: AssignmentProviderPort["reserve"]; provider?: AgentProvider;
  authorize: () => Promise<void>; executionDeadline: number; budget: { maxModelCalls: number; maxToolCalls: number };
}): Promise<Pick<AgentTurn, "text" | "endReason" | "toolInvocations" | "results">> {
  const stored = await continuation.load();
  const saved = stored == null ? null : checkpointState.parse(stored);
  let checkpoint: ProviderCheckpoint = saved?.checkpoint ?? { phase: "ready", sequence: 0, operation: null, lastReceipt: null };
  let result: unknown = saved?.result ?? null;
  const persist = async () => continuation.save({ version: 1, checkpoint, result });
  const next = async (phase: ProviderCheckpoint["phase"], operation: string | null, receipt: string | null) => {
    checkpoint = { phase, sequence: checkpoint.sequence + 1, operation, lastReceipt: receipt ?? checkpoint.lastReceipt };
    await persist();
    return checkpoint.sequence;
  };
  const save = async (_sequence: number, state: SavedProviderResponse) => {
    result = state;
    await persist();
  };
  const signal = AbortSignal.timeout(Math.max(0, executionDeadline - Date.now()));
  const advance = () => advanceAssignmentProvider(checkpoint, {
    load: async () => result,
    begin: (_sequence, operation) => next("provider_pending", operation, null),
    buildRequest: async (_operation, previous) => assignmentReadRequest(request, previous, [], assignmentReadTools, budget),
    reserve: async payload => {
      assertLunaPaidAcceptanceAllowed();
      await authorize();
      return reserve(payload);
    },
    save,
    complete: async (_sequence, operation) => { await next("ready", null, `provider:${operation}`); },
  }, signal, undefined, undefined, provider);
  try {
    await authorize();
    const interruptedRead = checkpoint.phase === "read_pending" || checkpoint.lastReceipt?.startsWith("read:");
    const final = await runAssignmentReadLoop({
      result: interruptedRead && checkpoint.phase !== "provider_pending" ? parseSavedProviderResponse(result) : await advance(),
      context: scope, readTools: assignmentReadTools, budget, signal, provider: advance, save, authorize,
      checkpoint: () => checkpoint,
      startRead: (_sequence, operation) => next("read_pending", operation, null),
      completeRead: async receipt => { await next("ready", null, `read:${receipt.operation}`); },
    });
    const toolInvocations = readAssignmentEvidence(final).map(({ name, data }) => ({
      name, result: { source: "sql_research", period: null, missing: [], tool: name, result: data,
        ...((name === "run_sql" && data.ok !== true) || data.ok === false ? { error: "research_tool_error" } : {}) },
    }));
    return { text: assignmentTextBlocks(final).map(block => block.text).join("\n\n"), endReason: "complete",
      toolInvocations, results: toolInvocations.map(call => call.result) };
  } catch (error) {
    if (!signal.aborted) throw error;
    await continuation.yield();
    throw new Error("research_execution_yield");
  }
}
