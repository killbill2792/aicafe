import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertCafeAiAccess } from "@/lib/access/access.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { routineDraftSchema } from "@/lib/ai/conversations/contracts";
import { needsExplicitGoalSource, routineGoalCandidates } from "@/lib/ai/conversations/routineGoalSources";
import { manageRoutineSchema, routineToolDefinition, routineTools } from "@/lib/ai/agent/tools/routines";
import { listOwnerRoutines } from "@/lib/ai/supervisor/routines/repository.server";
import { readAssignmentEvidence, type AssignmentReadTool } from "@/lib/luna/runtime/assignment-provider.server";
import { historyContent } from "@/lib/ai/conversations/historyContent";
import { ConversationService } from "@/lib/ai/conversations/service";
import { SupabaseConversationRepository } from "@/lib/ai/conversations/supabase.server";
import { decodeClaim, type RunScope } from "@/lib/ai/supervisor/runs/contracts";
import { loadModelExecutionCap } from "@/lib/ai/supervisor/runs/provider-reservation.server";
import type { WorkerBudget } from "@/lib/ai/supervisor/runs/usage.server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { assignmentReadTools, processLunaAssignment } from "@/lib/luna/runtime/assignment-worker.server";

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

function routineDraftReader(history: ConversationService, db: ReturnType<typeof createAdminSupabaseClient>, scope: RunScope): AssignmentReadTool {
  return {
    definition: { ...routineToolDefinition, description: routineToolDefinition.description +
      " In this conversation use only list_goal_sources, list, and create an unsaved draft. Use the existing owner controls to change saved schedules. The owner saves a draft through the approval card." },
    execute: async ({ ownerMessageId, originalInput }, args) => {
      const input = manageRoutineSchema.safeParse(args);
      const ownerText = originalInput?.text;
      if (!input.success || !ownerMessageId || !originalInput || !ownerText) return { ok: false, error: "invalid_tool_arguments" };
      if (!["create", "list", "list_goal_sources"].includes(input.data.action)) return { ok: false, error: "use_owner_routine_controls" };
      const owner = { id: ownerMessageId, threadId: scope.threadId, createdAt: originalInput.receivedAt };
      const goalSources = async (offset: number) => {
        const page = await history.listMessages(scope.threadId, offset);
        return { sources: routineGoalCandidates(page.items, owner, ownerText, offset === 0), nextOffset: page.nextOffset };
      };
      const page = input.data.action === "create" ? await goalSources(0) : null;
      const noMutation = async () => { throw new Error("use_owner_routine_controls"); };
      try {
        return await routineTools.manage_routine.execute(input.data, { routines: {
          list: () => listOwnerRoutines({ scope, threadId: scope.threadId, client: db }),
          goalSources,
          draft: (_, selected) => {
            if (!selected && page && needsExplicitGoalSource(page.sources.length, page.nextOffset))
              throw new Error("Choose the verified original owner goal message ID before saving");
            return { ownerMessageId, goalSourceMessageId: selected ?? ownerMessageId };
          },
          create: noMutation, change: noMutation,
        } });
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message.startsWith("Choose the verified original owner goal")
          ? error.message : "routine_request_unavailable" };
      }
    },
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
    ...(process.env.SUPERVISOR_U4_ENABLED === "true" ? {
      readTools: [...assignmentReadTools, routineDraftReader(history, db, scope)],
      resultBlocks: result => {
        const receipt = readAssignmentEvidence(result, true).findLast(item => item.name === "manage_routine" && item.data.routineDraft);
        const draft = routineDraftSchema.safeParse({ ...receipt?.data.routineDraft as object | undefined, type: "routine_draft" });
        return draft.success ? [draft.data] : [];
      },
    } : {}),
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
