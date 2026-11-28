import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { calculationToolDefinition, executeCalculationTool } from "@/lib/ai/research/calculation";
import {
  describeDatabase, describeResearchDatabaseToolDefinition, runSql, runSqlToolDefinition,
} from "@/lib/ai/research/tools.server";
import { decodeClaim, runScopeSchema, type RunScope } from "@/lib/ai/supervisor/runs/contracts";
import { workforceRoster } from "../workforce/roster";
import { runClaimedAssignmentProvider, type AssignmentReadTool } from "./assignment-provider.server";

const textPart = z.object({ type: z.literal("output_text"), text: z.string() });
const assistantMessage = z.object({
  type: z.literal("message"), role: z.literal("assistant"), content: z.array(textPart),
});
type ProviderArgs = Parameters<typeof runClaimedAssignmentProvider>[0];

const describeDatabaseArguments = z.strictObject({ tables: z.array(z.string()).nullable() });
const runSqlArguments = z.strictObject({ sql: z.string().trim().min(1) });
const assignmentReadTools: readonly AssignmentReadTool[] = [
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

/** Process one admitted replacement assignment using the existing claim,
 * provider checkpoint and atomic publication RPCs. */
export async function processLunaAssignment({
  scope: claimedScope, runId: id, ...provider
}: Omit<ProviderArgs, "lease" | "supersedeOperation"> & { scope: RunScope; runId: string }): Promise<"busy" | "blocked" | "completed"> {
  const scope = runScopeSchema.parse(claimedScope);
  const runId = z.uuid().parse(id);
  const identity = {
    p_business_id: scope.businessId, p_owner_user_id: scope.ownerUserId, p_thread_id: scope.threadId,
    p_run_id: runId,
  };
  const workerId = randomUUID();
  const signal = AbortSignal.any([provider.signal, AbortSignal.timeout(55_000)]);
  const claim = async () => {
    signal.throwIfAborted();
    return decodeClaim(await provider.rpc("luna_assignment_claim", {
      ...identity, p_worker_id: workerId, p_lease_seconds: 60,
    }));
  };
  let step = await claim();
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
      const employee = workforceRoster().find(profile => profile.key === context.employeeKey);
      if (!employee) throw new Error("luna_assignment_employee_unavailable");
      return { ...request, instructions: [request.instructions, `Your assigned role is ${employee.title}.`,
        employee.communicationStyle, ...employee.responsibilities].join("\n") };
    },
  };
  let supersedeOperation: string | undefined;
  for (;;) {
    const turn = await runClaimedAssignmentProvider({ ...providerArgs, supersedeOperation });
    if (!turn) return "busy";
    const items = turn.result.response.output.filter(item => item.type !== "reasoning");
    const blocks = z.array(assistantMessage).min(1).parse(items).flatMap(message => message.content)
      .filter(part => part.text.length > 0).map(part => ({ type: "text", text: part.text }));
    if (!blocks.length) throw new Error("luna_assignment_reply_empty");

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
