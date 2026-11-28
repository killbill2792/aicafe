import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupervisorReplyBlock } from "@/lib/ai/conversations/contracts";
import { calculationToolDefinition, executeCalculationTool } from "@/lib/ai/research/calculation";
import {
  describeDatabase, describeResearchDatabaseToolDefinition, runSql, runSqlToolDefinition,
} from "@/lib/ai/research/tools.server";
import { decodeClaim, runScopeSchema, type RunScope, type StepClaim } from "@/lib/ai/supervisor/runs/contracts";
import { workforceRoster } from "../workforce/roster";
import { LunaAssignmentYielded, runClaimedAssignmentProvider, type AssignmentReadTool, type SavedProviderResponse } from "./assignment-provider.server";

const textPart = z.object({ type: z.literal("output_text"), text: z.string() });
const assistantMessage = z.object({
  type: z.literal("message"), role: z.literal("assistant"), content: z.array(textPart),
});
type ProviderArgs = Parameters<typeof runClaimedAssignmentProvider>[0];

const describeDatabaseArguments = z.strictObject({ tables: z.array(z.string()).nullable() });
const runSqlArguments = z.strictObject({ sql: z.string().trim().min(1) });
export const assignmentReadTools: readonly AssignmentReadTool[] = [
  { definition: calculationToolDefinition, execute: (_, args) => executeCalculationTool(args) },
  {
    definition: describeResearchDatabaseToolDefinition,
    execute: async ({ businessId, ownerUserId }, args, signal) => {
      const input = describeDatabaseArguments.safeParse(args);
      if (!input.success) return { ok: false, error: "invalid_tool_arguments" };
      return describeDatabase({ businessId, ownerUserId, signal }, input.data.tables);
    },
  },
  {
    definition: runSqlToolDefinition,
    execute: async ({ businessId, ownerUserId }, args, signal) => {
      const input = runSqlArguments.safeParse(args);
      if (!input.success) return { ok: false, error: "invalid_tool_arguments" };
      return runSql({ businessId, ownerUserId, signal }, input.data.sql);
    },
  },
];

export function assignmentInstructions(instructions: string, key: string) {
  const employee = workforceRoster().find(profile => profile.key === key);
  if (!employee) throw new Error("luna_assignment_employee_unavailable");
  return [instructions, `Your assigned role is ${employee.title}.`,
    employee.communicationStyle, ...employee.responsibilities].join("\n");
}

export function assignmentTextBlocks(result: SavedProviderResponse) {
  const items = result.response.output.filter(item => item.type !== "reasoning");
  const blocks = z.array(assistantMessage).min(1).parse(items).flatMap(message => message.content)
    .filter(part => part.text.length > 0).map(part => ({ type: "text", text: part.text }));
  if (!blocks.length) throw new Error("luna_assignment_reply_empty");
  return blocks;
}

/** Process one admitted replacement assignment using the existing claim,
 * provider checkpoint and atomic publication RPCs. */
export async function processLunaAssignment({
  scope: claimedScope, runId: id, dispatch, resultBlocks, ...provider
}: Omit<ProviderArgs, "lease" | "supersedeOperation"> & {
  scope: RunScope; runId: string; dispatch?: { workerId: string; step: StepClaim };
  resultBlocks?: (result: SavedProviderResponse) => readonly SupervisorReplyBlock[];
}): Promise<"busy" | "blocked" | "completed"> {
  const scope = runScopeSchema.parse(claimedScope);
  const runId = z.uuid().parse(id);
  const identity = {
    p_business_id: scope.businessId, p_owner_user_id: scope.ownerUserId, p_thread_id: scope.threadId,
    p_run_id: runId,
  };
  const workerId = dispatch?.workerId ?? randomUUID();
  const signal = AbortSignal.any([provider.signal, AbortSignal.timeout(55_000)]);
  const claim = async () => {
    signal.throwIfAborted();
    return decodeClaim(await provider.rpc("luna_assignment_claim", {
      ...identity, p_worker_id: workerId, p_lease_seconds: 60,
    }));
  };
  let step = dispatch?.step ?? await claim();
  if (step.kind === "claimed" && step.key === "authorize_owner") {
    await provider.accounting.authorize();
    await provider.rpc("supervisor_run_complete_step", {
      ...identity, p_step_key: step.key, p_claim_token: step.claimToken, p_result_ref: `owner:${scope.ownerUserId}`,
    });
    step = await claim();
  }
  if (step.kind === "completed" || step.kind === "busy" || step.kind === "blocked") return step.kind;
  if (step.kind !== "claimed" || step.key !== "owner_turn") throw new Error("luna_assignment_step_unrecognized");

  const providerArgs: ProviderArgs = {
    ...provider, signal, lease: { ...scope, runId, claimToken: step.claimToken },
    readTools: provider.readTools ?? assignmentReadTools,
    buildRequest: async (context, steering) => {
      const request = await provider.buildRequest(context, steering);
      return { ...request, instructions: assignmentInstructions(request.instructions, context.employeeKey) };
    },
  };
  let supersedeOperation: string | undefined;
  for (;;) {
    const turn = await runClaimedAssignmentProvider({ ...providerArgs, supersedeOperation }).catch(error => {
      if (error instanceof LunaAssignmentYielded) return null;
      throw error;
    });
    if (!turn) return "busy";
    const blocks = [...assignmentTextBlocks(turn.result), ...resultBlocks?.(turn.result) ?? []];

    signal.throwIfAborted();
    const replyId = randomUUID();
    try {
      const receipt = await provider.rpc("luna_commit_assignment_result", {
        ...identity, p_claim_token: step.claimToken, p_job_id: turn.jobId, p_expected_seq: turn.sequence,
        p_provider_operation: turn.result.operation, p_reply_id: replyId, p_blocks: blocks,
        p_grounding: { status: "answered", ownerMessageId: turn.ownerMessageId, durableRunId: runId, agentMetadata: { endReason: "complete" } },
      });
      if (receipt !== replyId) throw new Error("luna_assignment_reply_unverified");
      return "completed";
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "assignment_has_new_input") throw error;
      supersedeOperation = turn.result.operation;
    }
  }
}
