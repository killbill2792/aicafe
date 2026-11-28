import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  loadModelExecutionCap, reserveDurableProviderRequest, withDurableProviderTurn, type DurableProviderScope,
} from "@/lib/ai/supervisor/runs/provider-reservation.server";
import { streamResponses } from "../shared/responses.server";
import { publicWebCheckpointSchema, type PublicWebContinuation } from "../shared/publicWebResearch.server";
import { rememberPrivateWebConversation } from "../shared/publicWebResearch";
import { employeeKeys, type EmployeeKey } from "../workforce/roster";

const completedResponse = z.object({
  id: z.string().min(1),
  status: z.literal("completed"),
  output: z.array(z.looseObject({ type: z.string().min(1) })),
  model: z.string().optional(),
  service_tier: z.string().nullish(),
  usage: z.unknown().optional(),
});

const wireItem = z.looseObject({ type: z.string().min(1) });
const toolCall = z.object({
  type: z.literal("function_call"), name: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  call_id: z.string().min(1).max(200), arguments: z.string(),
});
const toolReceipt = z.object({ operation: z.uuid(), callId: z.string(), output: z.string() });
const savedResponse = z.object({
  version: z.literal(1),
  operation: z.uuid(),
  response: completedResponse,
  transcript: z.array(wireItem).optional(),
  round: z.number().int().positive().optional(),
  toolReceipts: z.array(toolReceipt).optional(),
  sourceRevisions: z.record(z.string(),z.number().int().nonnegative()).optional(),
  webCheckpoint: publicWebCheckpointSchema.optional(),
});

export type SavedProviderResponse = z.infer<typeof savedResponse>;

export type ProviderCheckpoint = {
  phase: "ready" | "provider_pending" | "read_pending" | "effect_pending";
  sequence: number;
  operation: string | null;
  lastReceipt: string | null;
};

export type ProviderRequest = {
  model: string;
  instructions: string;
  input: readonly Record<string, unknown>[];
  tools?: readonly Record<string, unknown>[];
  tool_choice?: "auto" | "none";
  max_output_tokens: number;
};

export type AssignmentProviderPort = {
  load: (sequence: number) => Promise<unknown>;
  begin: (sequence: number, operation: string) => Promise<number>;
  buildRequest: (operation: string, previous: SavedProviderResponse | null) => Promise<ProviderRequest & {
    continuation?: Pick<SavedProviderResponse, "transcript" | "round" | "sourceRevisions">;
  }>;
  reserve: (request: Record<string, unknown>) => Promise<{
    launched: () => void;
    complete: (response: SavedProviderResponse["response"]) => Promise<void>;
  }>;
  save: (sequence: number, state: SavedProviderResponse) => Promise<void>;
  complete: (sequence: number, operation: string) => Promise<void>;
};

const providerEntry = z.object({
  job: z.object({ id: z.uuid(), owner_message_id: z.uuid(), status: z.enum(["running", "done"]) }),
  employeeKey: z.enum(employeeKeys),
  originalInput: z.object({
    text: z.string().nullable(), receivedAt: z.iso.datetime({ offset: true }),
    locale: z.enum(["en", "es", "ar"]), attachmentIds: z.array(z.uuid()),
  }),
  phase: z.enum(["ready", "provider_pending", "read_pending", "effect_pending"]),
  sequence: z.number().int().nonnegative(),
  operation: z.uuid().nullable(),
  lastReceipt: z.string().nullable(),
});
const steeringPage = z.array(z.object({ position: z.coerce.number().int().positive(), message_id: z.uuid(), content: z.string() }));

type AssignmentLease = { businessId: string; ownerUserId: string; threadId: string; runId: string; claimToken: string };
type ProviderContext = AssignmentLease & {
  jobId: string;
  ownerMessageId: string;
  employeeKey: EmployeeKey;
  originalInput: z.infer<typeof providerEntry>["originalInput"];
};
type AssignmentAccounting = Pick<DurableProviderScope, "db" | "budget" | "ownerDailyCap" | "authorize">;
type Rpc = (name: string, params: Record<string, unknown>) => Promise<unknown>;
type WebReadPort = Pick<PublicWebContinuation, "saved" | "save"> & { privateValues: ReadonlySet<string> };
export type AssignmentReadTool = {
  definition: Readonly<Record<string, unknown>> & { name: string };
  execute: (context: ProviderContext, args: Record<string, unknown>, signal: AbortSignal, web?: WebReadPort) => unknown;
  sourceRevision?: (context: ProviderContext) => Promise<number>;
  usesProvider?: boolean;
};

function requestedCalls(state: SavedProviderResponse) {
  const calls = state.response.output.filter(item => item.type === "function_call").map(item => toolCall.parse(item));
  if (new Set(calls.map(call => call.call_id)).size !== calls.length) throw new Error("luna_duplicate_tool_call");
  return calls;
}

function toolTranscript(previous: SavedProviderResponse) {
  const receipts = previous.toolReceipts ?? [];
  const calls = requestedCalls(previous);
  if (!calls.length || receipts.length !== calls.length || calls.some((call, i) => call.call_id !== receipts[i].callId)) {
    throw new Error("luna_tool_receipts_incomplete");
  }
  return [...previous.transcript ?? [], ...previous.response.output,
    ...receipts.map(receipt => ({ type: "function_call_output", call_id: receipt.callId, output: receipt.output }))];
}

async function readToolOutput(tool: AssignmentReadTool | undefined, raw: string, context: ProviderContext, signal: AbortSignal, web?: WebReadPort) {
  if (!tool) return { output: JSON.stringify({ ok: false, error: "tool_unavailable" }) };
  const args = z.record(z.string(), z.unknown());
  let parsed: z.infer<typeof args>;
  try { parsed = args.parse(JSON.parse(raw)); }
  catch { return { output: JSON.stringify({ ok: false, error: "invalid_tool_arguments" }) }; }
  let revision: number | undefined;
  try { revision = await tool.sourceRevision?.(context); }
  catch (error) {
    return { output: JSON.stringify({ ok:false, error:error instanceof Error&&error.message==="public_web_access_revoked"?
      "permissionDenied":"permissionsUnavailable" }) };
  }
  const result = await tool.execute(context, parsed, signal, web);
  const status = result as { ok?: unknown; error?: unknown } | null;
  const settledProvider = tool.usesProvider && status?.error !== "timeout";
  if (revision !== undefined && status?.ok === true) {
    if (await tool.sourceRevision?.(context) !== revision) throw new Error("luna_source_access_changed");
    return { output: JSON.stringify(result), revision, settledProvider };
  }
  return { output: JSON.stringify(result ?? null), settledProvider };
}

/** Both interactive and scheduled dispatch can pass their existing owner-turn
 * lease here. Only the scoped request builder selects inputs and capabilities. */
export async function runClaimedAssignmentProvider({
  lease, rpc, signal, request, buildRequest, accounting, readTools,
}: {
  lease: AssignmentLease;
  rpc: Rpc;
  signal: AbortSignal;
  request?: typeof fetch;
  buildRequest: (context: ProviderContext, steering: z.infer<typeof steeringPage>) => Promise<ProviderRequest>;
  accounting: AssignmentAccounting;
  readTools?: readonly AssignmentReadTool[];
}): Promise<{ jobId: string; ownerMessageId: string; sequence: number; result: SavedProviderResponse; assertSources?: () => Promise<void> } | null> {
  signal.throwIfAborted();
  const scope = {
    p_business_id: lease.businessId, p_owner_user_id: lease.ownerUserId, p_thread_id: lease.threadId,
    p_run_id: lease.runId, p_claim_token: lease.claimToken,
  };
  const entry = providerEntry.nullable().parse(await rpc("luna_open_assignment_provider", scope));
  if (!entry || entry.job.status === "done") return null;
  const context = {
    ...lease, jobId: entry.job.id, ownerMessageId: entry.job.owner_message_id,
    employeeKey: entry.employeeKey, originalInput: entry.originalInput,
  };
  let checkpoint: ProviderCheckpoint = entry;
  const checkpointSequence = z.object({ checkpoint_seq: z.number().int().nonnegative() });
  const transition = async (sequence: number, operation: string, action: "begin_provider" | "begin_read" | "complete",
    tool: string | null, receipt: string | null) => {
    const data = await rpc("supervisor_checkpoint_owner_run_v2", {
      ...scope, p_expected_seq: sequence, p_operation: operation,
      p_action: action, p_tool: tool, p_receipt_ref: receipt,
    });
    const next = checkpointSequence.parse(data).checkpoint_seq;
    checkpoint = { sequence: next, operation: action === "complete" ? null : operation,
      phase: action === "complete" ? "ready" : action === "begin_read" ? "read_pending" : "provider_pending",
      lastReceipt: receipt ?? checkpoint.lastReceipt };
    return next;
  };
  const load = (sequence: number) => rpc("supervisor_research_checkpoint_v2", {
    ...scope, p_expected_seq: sequence, p_write: false, p_state: null,
  });
  const save = async (sequence: number, state: SavedProviderResponse) => {
    if (await rpc("supervisor_research_checkpoint_v2", {
      ...scope, p_expected_seq: sequence, p_write: true, p_state: state,
    }) !== true) throw new Error("luna_provider_checkpoint_not_saved");
  };
  const verifySources = async (state: SavedProviderResponse | null) => {
    for (const [name, revision] of Object.entries(state?.sourceRevisions ?? {})) {
      const tool = readTools?.find(item => item.definition.name === name);
      if (await tool?.sourceRevision?.(context) !== revision) throw new Error("luna_source_access_changed");
    }
  };
  const provider = () => advanceAssignmentProvider(checkpoint, {
    load, save,
    begin: (sequence, operation) => transition(sequence, operation, "begin_provider", null, null),
    buildRequest: async (operation, previous) => {
      await verifySources(previous);
      const steering: z.infer<typeof steeringPage> = [];
      const limit = 100;
      let after = 0;
      for (;;) {
        signal.throwIfAborted();
        const page = steeringPage.parse(await rpc("luna_provider_inputs", {
          ...scope, p_operation: operation, p_after: after, p_limit: limit,
        }));
        steering.push(...page);
        if (page.length < limit) break;
        after = page[page.length - 1].position;
      }
      if (!readTools) return buildRequest(context, steering);
      const base = await buildRequest(context, []);
      const fresh = steering.map(item => ({ type: "message", role: "user", content: item.content }));
      const transcript = [...(previous ? toolTranscript(previous) : []), ...fresh];
      const usedTools = transcript.filter(item => item.type === "function_call_output").length;
      const round = (previous?.round ?? (previous ? 1 : 0)) + 1;
      const canUseTools = usedTools < accounting.budget.maxToolCalls && round < accounting.budget.maxModelCalls;
      const tools = canUseTools ? readTools.map(tool => tool.definition) : [];
      return { ...base, input: [...base.input, ...transcript], tools, tool_choice: tools.length ? "auto" : "none",
        continuation: { transcript, round, ...(previous?.sourceRevisions ? { sourceRevisions:previous.sourceRevisions } : {}) } };
    },
    reserve: async (payload) => {
      if (process.env.AI_CAFE_LIVE_ACCEPTANCE === "OWNER_APPROVED_LOCAL_ONLY" || process.env.AICAFE_TASK14B_BUDGET_LEDGER) {
        throw new Error("luna_assignment_requires_separate_paid_acceptance");
      }
      const outputCap = await loadModelExecutionCap(accounting.db, String(payload.model));
      const reservation = await withDurableProviderTurn({ ...accounting, ...lease, jobId: context.jobId, ownerMessageId: context.ownerMessageId },
        () => reserveDurableProviderRequest(payload, "responses", outputCap));
      if (!reservation) throw new Error("luna_assignment_reservation_unavailable");
      return reservation;
    },
    complete: async (sequence, operation) => {
      await transition(sequence, operation, "complete", null, `provider:${operation}`);
    },
  }, signal, request);
  const resumingRead = entry.phase === "read_pending" || (entry.phase === "ready" && entry.lastReceipt?.startsWith("read:"));
  if (resumingRead && !readTools) throw new Error("luna_provider_requires_recovered_tool_boundary");
  let result = resumingRead ? savedResponse.parse(await load(entry.sequence)) : await provider();
  await verifySources(result);
  if (readTools) {
    for (let calls = requestedCalls(result); calls.length; calls = requestedCalls(result)) {
      if ((result.round ?? 1) >= accounting.budget.maxModelCalls) throw new Error("luna_assignment_provider_budget_exhausted");
      const receipts = [...result.toolReceipts ?? []];
      const completeRead = async (receipt: z.infer<typeof toolReceipt>) => {
        const digest = createHash("sha256").update(receipt.output).digest("hex");
        const ref = `read:${receipt.operation.replaceAll("-", "")}_${digest}`;
        await transition(checkpoint.sequence, receipt.operation, "complete", null, ref);
      };
      const last = receipts.at(-1);
      if (last && checkpoint.phase === "read_pending" && checkpoint.operation === last.operation) await completeRead(last);
      const previousReads = result.transcript?.filter(item => item.type === "function_call_output").length ?? 0;
      for (let index = receipts.length; index < calls.length; index++) {
        const call = calls[index];
        signal.throwIfAborted();
        const operation = checkpoint.operation ?? randomUUID();
        if (checkpoint.phase === "ready") await transition(checkpoint.sequence, operation, "begin_read", call.name, null);
        await accounting.authorize();
        const tool = previousReads + index < accounting.budget.maxToolCalls
          ? readTools.find(item => item.definition.name === call.name) : undefined;
        const remaining = accounting.budget.maxModelCalls - (result.round ?? 1);
        const privateValues = new Set<string>();
        let web: WebReadPort | undefined;
        if (tool?.usesProvider) {
          rememberPrivateWebConversation(privateValues, context.originalInput.text,
            ...(result.transcript ?? []).filter(item => item.type === "message" && item.role === "user")
              .map(item => typeof item.content === "string" ? item.content : null));
          web = { saved:result.webCheckpoint, privateValues, save:async state => {
            await save(checkpoint.sequence, { ...result, toolReceipts:receipts, webCheckpoint:state });
            result.webCheckpoint = state;
          } };
        }
        const { output, revision, settledProvider } = await readToolOutput(
          tool?.usesProvider && remaining < 2 ? undefined : tool, call.arguments, context, signal, web);
        if (!settledProvider) signal.throwIfAborted();
        const receipt = { operation, callId: call.call_id, output };
        if (result.webCheckpoint) result.round = (result.round ?? 1) + 1;
        if (revision !== undefined) {
          result.sourceRevisions = { ...result.sourceRevisions, [call.name]:revision };
          await verifySources(result);
        }
        receipts.push(receipt);
        delete result.webCheckpoint;
        await save(checkpoint.sequence, { ...result, toolReceipts: receipts });
        await completeRead(receipt);
        signal.throwIfAborted();
      }
      result = await provider();
    }
  }
  await verifySources(result);
  return { jobId: context.jobId, ownerMessageId: context.ownerMessageId, sequence: checkpoint.sequence, result,
    ...(result.sourceRevisions ? { assertSources:() => verifySources(result) } : {}) };
}

/** Advance a leased assignment by one provider operation. The database port
 * fences every transition and stores the response before writing its receipt. */
export async function advanceAssignmentProvider(
  checkpoint: ProviderCheckpoint,
  port: AssignmentProviderPort,
  signal: AbortSignal,
  request?: typeof fetch,
): Promise<SavedProviderResponse> {
  if (checkpoint.phase !== "ready" && checkpoint.phase !== "provider_pending") {
    throw new Error("luna_provider_requires_recovered_tool_boundary");
  }
  signal.throwIfAborted();
  const stored = await port.load(checkpoint.sequence);
  const saved = stored == null ? null : savedResponse.parse(stored);
  if (saved && checkpoint.phase === "ready" && checkpoint.lastReceipt === `provider:${saved.operation}`) {
    return saved;
  }
  if (checkpoint.phase === "provider_pending" && !checkpoint.operation) {
    throw new Error("luna_provider_missing_operation");
  }
  const operation = checkpoint.operation ?? randomUUID();
  const sequence = checkpoint.phase === "ready" ? await port.begin(checkpoint.sequence, operation) : checkpoint.sequence;
  if (saved?.operation === operation) {
    await port.complete(sequence, operation);
    return saved;
  }

  const { continuation, ...input } = await port.buildRequest(operation, saved);
  const payload = { ...input, stream: true, store: false, include: ["reasoning.encrypted_content"] };
  const serialized = JSON.stringify(payload);
  signal.throwIfAborted();
  const reservation = await port.reserve(payload);
  signal.throwIfAborted();
  reservation.launched();
  for await (const event of streamResponses(input.model, serialized, signal, request)) {
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      throw new Error("luna_provider_response_unsettled");
    }
    if (event.type !== "response.completed") continue;
    const response = completedResponse.parse(event.response);
    await reservation.complete(response);
    const state: SavedProviderResponse = { version: 1, operation, response, ...continuation };
    await port.save(sequence, state);
    await port.complete(sequence, operation);
    return state;
  }
  throw new Error("luna_provider_response_unsettled");
}
