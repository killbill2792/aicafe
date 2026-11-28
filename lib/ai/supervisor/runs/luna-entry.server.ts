import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertCafeAiAccess } from "@/lib/access/access.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { historyContent } from "@/lib/ai/conversations/historyContent";
import { ConversationService } from "@/lib/ai/conversations/service";
import { SupabaseConversationRepository } from "@/lib/ai/conversations/supabase.server";
import { decodeClaim, type RunScope } from "@/lib/ai/supervisor/runs/contracts";
import { loadModelExecutionCap } from "@/lib/ai/supervisor/runs/provider-reservation.server";
import type { WorkerBudget } from "@/lib/ai/supervisor/runs/usage.server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { processLunaAssignment } from "@/lib/luna/runtime/assignment-worker.server";

type ExecutionOptions = { budget: WorkerBudget; ownerDailyCap: number | null; signal: AbortSignal };
const dispatchRecord = z.object({
  run_id: z.uuid(), business_id: z.uuid(), owner_user_id: z.uuid(), thread_id: z.uuid(), claim: z.unknown(),
}).nullable();

function assignmentRpc(db: ReturnType<typeof createAdminSupabaseClient>, signal: AbortSignal) {
  return async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args).abortSignal(signal);
    if (error) throw new Error(error.message, { cause: error });
    return data;
  };
}

export async function runScopedLunaAssignment(
  scope: RunScope, runId: string, options: ExecutionOptions,
  dispatch?: Parameters<typeof processLunaAssignment>[0]["dispatch"],
) {
  const db = createAdminSupabaseClient();
  const rpc = assignmentRpc(db, options.signal);
  const history = new ConversationService(new SupabaseConversationRepository(db), scope);
  return processLunaAssignment({
    scope, runId, rpc, dispatch, signal: options.signal,
    accounting: { db, budget: options.budget, ownerDailyCap: options.ownerDailyCap,
      authorize: () => assertCafeAiAccess(scope.businessId) },
    buildRequest: async context => {
      const model = configuredSupervisorModel();
      const { items } = await history.listMessages(scope.threadId, 0);
      if (context.originalInput.attachmentIds.length) throw new Error("luna_assignment_attachments_unavailable");
      return {
        model, max_output_tokens: await loadModelExecutionCap(db, model),
        instructions: "Answer the café owner's assignment in their requested language (" + context.originalInput.locale +
          "). Use the café's authorized sources. Cite the evidence and say when data is missing.",
        input: [
          ...items.filter(message => Date.parse(message.createdAt) < Date.parse(context.originalInput.receivedAt))
            .map(message => ({ role: message.role === "owner" ? "user" : "assistant", content: historyContent(message) }))
            .filter(message => message.content),
          { role: "user", content: context.originalInput.text ?? "" },
        ],
      };
    },
  });
}

export async function runNextLunaAssignment(options: ExecutionOptions) {
  const workerId = randomUUID();
  const rpc = assignmentRpc(createAdminSupabaseClient(), options.signal);
  const next = dispatchRecord.parse(await rpc("luna_claim_next_assignment", {
    p_worker_id: workerId, p_lease_seconds: 60,
  }));
  if (!next) return { processed: 0, state: null };
  if (z.object({ kind: z.literal("recovery") }).safeParse(next.claim).success) return { processed: 1, state: "blocked" };
  const scope = { businessId: next.business_id, ownerUserId: next.owner_user_id, threadId: next.thread_id };
  const state = await runScopedLunaAssignment(scope, next.run_id, options, { workerId, step: decodeClaim(next.claim) });
  return { processed: 1, state };
}
