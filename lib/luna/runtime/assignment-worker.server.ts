import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { calculationToolDefinition, executeCalculationTool } from "@/lib/ai/research/calculation";
import { describeDatabase, describeDatabaseToolDefinition } from "@/lib/ai/research/tools.server";
import { decodeClaim, runScopeSchema, type RunScope } from "@/lib/ai/supervisor/runs/contracts";
import { readCafeAccess, readExternalAccess, requireConnectorMembership, type AccessReader } from "@/lib/connectors/publicWebAccess.server";
import { readWithSourceAccess } from "@/lib/externalData/pages";
import { publicResearchIncludesPrivateValue, publicWebResearchTool } from "@/lib/connectors/publicWebResearch";
import { createWebSearch } from "@/lib/connectors/publicWebResearch.server";
import { loadModelExecutionCap, reserveDurableProviderRequest, withDurableProviderTurn } from "@/lib/ai/supervisor/runs/provider-reservation.server";
import { workforceRoster } from "../workforce/roster";
import { runClaimedAssignmentProvider, type AssignmentReadTool } from "./assignment-provider.server";

const textPart = z.object({ type: z.literal("output_text"), text: z.string() });
const assistantMessage = z.object({
  type: z.literal("message"), role: z.literal("assistant"), content: z.array(textPart),
});
type ProviderArgs = Parameters<typeof runClaimedAssignmentProvider>[0];

const describeDatabaseArguments = z.strictObject({ tables: z.array(z.string()).nullable() });
const webArguments = z.strictObject({ query: z.string().trim().min(1) });
const assignmentReadTools: readonly AssignmentReadTool[] = [
  { definition: calculationToolDefinition, execute: (_, args) => executeCalculationTool(args) },
  {
    definition: describeDatabaseToolDefinition,
    execute: async ({ businessId, ownerUserId }, args, signal) => {
      const input = describeDatabaseArguments.safeParse(args);
      if (!input.success) return { ok: false, error: "invalid_tool_arguments" };
      return describeDatabase({ businessId, ownerUserId, signal }, input.data.tables);
    },
  },
];

function assignmentWebResearch(accounting: ProviderArgs["accounting"]): AssignmentReadTool {
  const assertAccess: NonNullable<AssignmentReadTool["sourceRevision"]> = async context => {
    if(!("from" in accounting.db)||typeof accounting.db.from!=="function")throw Error("public_web_permission_unavailable");
    const db=accounting.db as AccessReader;
    await accounting.authorize();
    await requireConnectorMembership(db,context);
    const [entitlement,permission]=await Promise.all([readCafeAccess(db,context.businessId),readExternalAccess(db,context,"public_web","public")]);
    if(!entitlement.active||!permission.allowed)throw Error("public_web_access_revoked");
    return permission.revision;
  };
  return {
    definition: publicWebResearchTool,
    sourceRevision: assertAccess,
    usesProvider: true,
    execute: async (context, args, signal) => {
      const parsed = webArguments.safeParse(args);
      if (!parsed.success) return { ok:false, error:"invalid_tool_arguments" };
      if (publicResearchIncludesPrivateValue(parsed.data.query))
        return { ok:false, error:"Rewrite the search as a public research objective without private values." };
      const authorize=() => assertAccess(context);
      const lookup=createWebSearch({fetch:(input,init)=>readWithSourceAccess(authorize,()=>fetch(input,init),
        async response=>{await response.body?.cancel().catch(()=>undefined);})});
      const value = await readWithSourceAccess(authorize, () => withDurableProviderTurn({ ...accounting, ...context }, async () => {
        const outputCap = await loadModelExecutionCap(accounting.db);
        return lookup(parsed.data.query, {
          outputCap,
          reserveTransport: request => reserveDurableProviderRequest(request,"hosted_web",outputCap),
          reserveModelCall: () => true,
          recordUsage: () => {},
        }, signal);
      }));
      return value.available ? { ok:true, result:value } : { ok:false, error:value.reason };
    },
  };
}

/** Process one admitted replacement assignment using the existing claim,
 * provider checkpoint and atomic publication RPCs. */
export async function processLunaAssignment({
  scope: claimedScope, runId: id, ...provider
}: Omit<ProviderArgs, "lease"> & { scope: RunScope; runId: string }): Promise<"busy" | "blocked" | "completed"> {
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

  const turn = await runClaimedAssignmentProvider({
    ...provider, signal, lease: { ...scope, runId, claimToken: step.claimToken },
    readTools: provider.readTools ?? [...assignmentReadTools, assignmentWebResearch(provider.accounting)],
    buildRequest: async (context, steering) => {
      const request = await provider.buildRequest(context, steering);
      const employee = workforceRoster().find(profile => profile.key === context.employeeKey);
      if (!employee) throw new Error("luna_assignment_employee_unavailable");
      return { ...request, instructions: [request.instructions, `Your assigned role is ${employee.title}.`,
        employee.communicationStyle, ...employee.responsibilities].join("\n") };
    },
  });
  if (!turn) return "busy";
  const items = turn.result.response.output.filter(item => item.type !== "reasoning");
  const blocks = z.array(assistantMessage).min(1).parse(items).flatMap(message => message.content)
    .filter(part => part.text.length > 0).map(part => ({ type: "text", text: part.text }));
  if (!blocks.length) throw new Error("luna_assignment_reply_empty");

  await turn.assertSources?.();
  signal.throwIfAborted();
  const replyId = randomUUID();
  const receipt = await provider.rpc("luna_commit_assignment_result", {
    ...identity, p_claim_token: step.claimToken, p_job_id: turn.jobId, p_expected_seq: turn.sequence,
    p_provider_operation: turn.result.operation, p_reply_id: replyId, p_blocks: blocks,
    p_grounding: { status: "answered", ownerMessageId: turn.ownerMessageId, durableRunId: runId, agentMetadata: { endReason: "complete" } },
  });
  if (receipt !== replyId) throw new Error("luna_assignment_reply_unverified");
  return "completed";
}
