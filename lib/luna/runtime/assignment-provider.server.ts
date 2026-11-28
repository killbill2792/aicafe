import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  durableProviderRequestByteLimit, loadModelExecutionCap, reserveDurableProviderRequest, withDurableProviderTurn,
  type DurableProviderScope,
} from "@/lib/ai/supervisor/runs/provider-reservation.server";
import { streamResponses } from "../shared/responses.server";
import { employeeKeys, type EmployeeKey } from "../workforce/roster";

const responsesResult = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "incomplete"]),
  output: z.array(z.looseObject({ type: z.string().min(1) })),
  model: z.string().optional(),
  service_tier: z.string().nullish(),
  usage: z.unknown().optional(),
});

const wireItem = z.looseObject({ type: z.string().min(1) });
const responseIdentity = z.object({ id: z.string().min(1), model: z.string().optional() });
const draftText = z.object({ type: z.literal("output_text"), text: z.string().min(1) });
const toolCall = z.object({
  type: z.literal("function_call"), name: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  call_id: z.string().min(1).max(200), arguments: z.string(),
});
const toolReceipt = z.object({ operation: z.uuid(), callId: z.string(), output: z.string() });
const savedResponse = z.object({
  version: z.literal(1),
  operation: z.uuid(),
  response: responsesResult,
  transcript: z.array(wireItem).optional(),
  requestBytes: z.number().int().nonnegative().optional(),
  toolReceipts: z.array(toolReceipt).optional(),
});

export type SavedProviderResponse = z.infer<typeof savedResponse>;
export const parseSavedProviderResponse = (value: unknown) => savedResponse.parse(value);
export class LunaAssignmentYielded extends Error {}
type AssignmentSlice = { window?: AbortSignal; modelCalls: number; toolCalls: number };

export function assertLunaPaidAcceptanceAllowed() {
  if (process.env.AI_CAFE_LIVE_ACCEPTANCE === "OWNER_APPROVED_LOCAL_ONLY" || process.env.AICAFE_TASK14B_BUDGET_LEDGER) {
    throw new Error("luna_assignment_requires_separate_paid_acceptance");
  }
}

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
    continuation?: Pick<SavedProviderResponse, "transcript">;
  }>;
  reserve: (request: Record<string, unknown>) => Promise<{
    launched: () => void;
    complete: (response: SavedProviderResponse["response"], outcome?: "completed" | "incomplete") => Promise<void>;
  }>;
  save: (sequence: number, state: SavedProviderResponse) => Promise<void>;
  complete: (sequence: number, operation: string, interrupted?: true) => Promise<void>;
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
type AssignmentReadScope = Pick<ProviderContext, "businessId" | "ownerUserId"> & Partial<Pick<ProviderContext, "ownerMessageId" | "originalInput">>;
export type AssignmentReadTool = {
  definition: Readonly<Record<string, unknown>> & { name: string };
  execute: (context: AssignmentReadScope, args: Record<string, unknown>, signal: AbortSignal) => unknown;
};

function requestedCalls(state: SavedProviderResponse) {
  const calls = state.response.output.filter(item => item.type === "function_call").map(item => toolCall.parse(item));
  if (new Set(calls.map(call => call.call_id)).size !== calls.length) throw new Error("luna_duplicate_tool_call");
  return calls;
}

function resumableItems(items: readonly z.infer<typeof wireItem>[]) {
  return items.flatMap<z.infer<typeof wireItem>>(item => {
    const closed = item.status !== "incomplete" && item.status !== "in_progress";
    if (item.type === "reasoning" && closed && typeof item.encrypted_content === "string" && item.encrypted_content.length) {
      return [item];
    }
    if (item.type === "function_call" && closed && toolCall.safeParse(item).success) return [item];
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return [];
    const content = item.content.flatMap(part => {
      const text = draftText.safeParse(part);
      return text.success ? [{ ...text.data, annotations: [] }] : [];
    });
    return content.length ? [{ type: "message", role: "assistant", content }] : [];
  });
}

export const providerReceipt = (operation: string, interrupted: boolean) =>
  `${interrupted ? "provider_partial" : "provider"}:${operation}`;

const toolOutput = ({ callId, output }: Pick<z.infer<typeof toolReceipt>, "callId" | "output">) =>
  ({ type: "function_call_output", call_id: callId, output });

function toolTranscript(previous: SavedProviderResponse) {
  const receipts = previous.toolReceipts ?? [];
  const calls = requestedCalls(previous);
  if (receipts.length !== calls.length || calls.some((call, i) => call.call_id !== receipts[i].callId)) {
    throw new Error("luna_tool_receipts_incomplete");
  }
  // A draft rejected at publication leaves its prior instructions and tool evidence usable.
  if (!calls.length && previous.response.status === "completed") return previous.transcript ?? [];
  return [...previous.transcript ?? [], ...previous.response.output,
    ...receipts.map(toolOutput)];
}

const overCapacity = JSON.stringify({
  ok: false, error: "tool_result_exceeds_provider_capacity",
  detail: "Request a smaller result. For SQL, select the relevant fields and aggregate or page the results.",
});

function fitReadReceipt(state: SavedProviderResponse, previous: readonly z.infer<typeof toolReceipt>[],
  receipt: z.infer<typeof toolReceipt>, remainingCalls: readonly z.infer<typeof toolCall>[]) {
  const requestBytes = state.requestBytes ?? Buffer.byteLength(JSON.stringify(state.transcript ?? []));
  const continuation = [...state.response.output, ...previous.map(toolOutput), toolOutput(receipt),
    ...remainingCalls.map(call => toolOutput({ callId: call.call_id, output: overCapacity }))];
  if (requestBytes + Buffer.byteLength(JSON.stringify(continuation)) <= durableProviderRequestByteLimit) return receipt;
  return { ...receipt, output: overCapacity };
}

async function readToolOutput(tool: AssignmentReadTool | undefined, raw: string, context: AssignmentReadScope, signal: AbortSignal) {
  if (!tool) return JSON.stringify({ ok: false, error: "tool_unavailable" });
  const args = z.record(z.string(), z.unknown());
  let parsed: z.infer<typeof args>;
  try { parsed = args.parse(JSON.parse(raw)); }
  catch { return JSON.stringify({ ok: false, error: "invalid_tool_arguments" }); }
  return JSON.stringify(await tool.execute(context, parsed, signal) ?? null);
}

/** Both interactive and scheduled dispatch can pass their existing owner-turn
 * lease here. Only the scoped request builder selects inputs and capabilities. */
export async function runClaimedAssignmentProvider({
  lease, rpc, signal: callerSignal, request, buildRequest, accounting, readTools, supersedeOperation,
  slice = { modelCalls: 0, toolCalls: 0 },
}: {
  lease: AssignmentLease;
  rpc: Rpc;
  signal: AbortSignal;
  request?: typeof fetch;
  buildRequest: (context: ProviderContext, steering: z.infer<typeof steeringPage>) => Promise<ProviderRequest>;
  accounting: AssignmentAccounting;
  readTools?: readonly AssignmentReadTool[];
  supersedeOperation?: string;
  slice?: AssignmentSlice;
}): Promise<{ jobId: string; ownerMessageId: string; sequence: number; result: SavedProviderResponse } | null> {
  callerSignal.throwIfAborted();
  const signal = slice.window ? AbortSignal.any([callerSignal, slice.window]) : callerSignal;
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
  const yieldClaim = async () => {
    callerSignal.throwIfAborted();
    if (await rpc("supervisor_yield_owner_run_v2", {
      ...scope, p_expected_seq: checkpoint.sequence, p_delay_seconds: 15, p_yield_kind: "technical",
    }) !== true) throw new Error("luna_assignment_yield_unverified");
    throw new LunaAssignmentYielded();
  };
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
  const provider = async (after = supersedeOperation) => {
    let launched = false;
    try {
      return await advanceAssignmentProvider(checkpoint, {
        load, save,
        begin: (sequence, operation) => transition(sequence, operation, "begin_provider", null, null),
        buildRequest: async (operation, previous) => {
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
          if (!readTools && !previous) return buildRequest(context, steering);
          const base = await buildRequest(context, readTools ? [] : steering);
          const fresh = readTools ? steering.map(item => ({ type: "message", role: "user", content: item.content })) : [];
          return assignmentReadRequest(base, previous, fresh, readTools ?? [], accounting.budget);
        },
        reserve: async (payload) => {
          assertLunaPaidAcceptanceAllowed();
          const outputCap = await loadModelExecutionCap(accounting.db, String(payload.model));
          try {
            const reservation = await withDurableProviderTurn({ ...accounting, ...lease, jobId: context.jobId, ownerMessageId: context.ownerMessageId },
              () => reserveDurableProviderRequest(payload, "responses", outputCap));
            if (!reservation) throw new Error("luna_assignment_reservation_unavailable");
            slice.modelCalls++;
            return { ...reservation, launched: () => { reservation.launched(); launched = true; } };
          } catch (error) {
            if (!slice.modelCalls || !(error instanceof Error) || error.message !== "durable_provider_reservation_denied" ||
                !z.object({ message: z.literal("durable_provider_budget_exhausted") }).safeParse(error.cause).success) throw error;
            return yieldClaim();
          }
        },
        complete: async (sequence, operation, interrupted) => {
          await transition(sequence, operation, "complete", null, providerReceipt(operation, interrupted ?? false));
        },
      }, signal, request, after, undefined, slice.window);
    } catch (error) {
      if (!launched && slice.window?.aborted && error === slice.window.reason) await yieldClaim();
      throw error;
    }
  };
  const resumingRead = entry.phase === "read_pending" || (entry.phase === "ready" && entry.lastReceipt?.startsWith("read:"));
  if (resumingRead && !readTools) throw new Error("luna_provider_requires_recovered_tool_boundary");
  let result = resumingRead ? savedResponse.parse(await load(entry.sequence)) : await provider();
  if (readTools || result.response.status === "incomplete") {
    result = await runAssignmentReadLoop({
      result, context, readTools: readTools ?? [], budget: accounting.budget, signal, callerSignal, slice, yieldClaim,
      provider, save, checkpoint: () => checkpoint, authorize: accounting.authorize,
      startRead: (sequence, operation, tool) => transition(sequence, operation, "begin_read", tool, null),
      completeRead: async receipt => {
        const digest = createHash("sha256").update(receipt.output).digest("hex");
        const ref = `read:${receipt.operation.replaceAll("-", "")}_${digest}`;
        await transition(checkpoint.sequence, receipt.operation, "complete", null, ref);
      },
    });
  }
  return { jobId: context.jobId, ownerMessageId: context.ownerMessageId, sequence: checkpoint.sequence, result };
}

type ReadLimits = { maxToolCalls: number };

export function assignmentReadRequest(base: ProviderRequest, previous: SavedProviderResponse | null,
  fresh: SavedProviderResponse["transcript"], readTools: readonly AssignmentReadTool[], limits: ReadLimits) {
  const transcript = [...(previous ? toolTranscript(previous) : []), ...fresh ?? []];
  const tools = limits.maxToolCalls > 0 ? readTools.map(tool => tool.definition) : [];
  const instructions = previous?.response.status === "incomplete"
    ? base.instructions + "\nContinue the interrupted work and produce the complete answer when the assignment is finished."
    : base.instructions;
  return { ...base, instructions, input: [...base.input, ...transcript], tools, tool_choice: tools.length ? "auto" as const : "none" as const,
    continuation: { transcript } };
}

export async function runAssignmentReadLoop({ result, context, readTools, budget, signal, callerSignal, slice, yieldClaim,
  provider, save, checkpoint, authorize, startRead, completeRead }: {
  result: SavedProviderResponse; context: AssignmentReadScope;
  readTools: readonly AssignmentReadTool[]; budget: ReadLimits; signal: AbortSignal; callerSignal?: AbortSignal;
  slice: Pick<AssignmentSlice, "window" | "toolCalls">; yieldClaim: () => Promise<never>;
  provider: (after?: string) => Promise<SavedProviderResponse>; save: AssignmentProviderPort["save"];
  checkpoint: () => ProviderCheckpoint; authorize: () => Promise<void>;
  startRead: (sequence: number, operation: string, tool: string) => Promise<unknown>;
  completeRead: (receipt: z.infer<typeof toolReceipt>) => Promise<void>;
}) {
  for (;;) {
    const calls = requestedCalls(result);
    if (!calls.length && result.response.status === "completed") return result;
    const receipts = [...result.toolReceipts ?? []];
    const last = receipts.at(-1);
    if (last && checkpoint().phase === "read_pending" && checkpoint().operation === last.operation) await completeRead(last);
    for (let index = receipts.length; index < calls.length; index++) {
      if (slice.window?.aborted || (budget.maxToolCalls > 0 && slice.toolCalls >= budget.maxToolCalls)) await yieldClaim();
      const call = calls[index];
      signal.throwIfAborted();
      const operation = checkpoint().operation ?? randomUUID();
      if (checkpoint().phase === "ready") await startRead(checkpoint().sequence, operation, call.name);
      await authorize();
      const tool = budget.maxToolCalls > 0 ? readTools.find(item => item.definition.name === call.name) : undefined;
      slice.toolCalls++;
      const output = await readToolOutput(tool, call.arguments, context, signal);
      callerSignal?.throwIfAborted();
      const receipt = fitReadReceipt(result, receipts, { operation, callId: call.call_id, output }, calls.slice(index + 1));
      receipts.push(receipt);
      await save(checkpoint().sequence, { ...result, toolReceipts: receipts });
      await completeRead(receipt);
    }
    result = await provider(result.operation);
  }
}

export function readAssignmentEvidence(result: SavedProviderResponse, afterOwnerInput = false) {
  const transcript = result.transcript ?? [];
  const start = afterOwnerInput ? transcript.findLastIndex(item => item.role === "user") + 1 : 0;
  const calls = new Map<string, string>();
  return transcript.slice(start).flatMap(item => {
    if (item.type === "function_call") {
      const call = toolCall.parse(item);
      calls.set(call.call_id, call.name);
      return [];
    }
    if (item.type !== "function_call_output" || typeof item.call_id !== "string" || typeof item.output !== "string") return [];
    const name = calls.get(item.call_id);
    calls.delete(item.call_id);
    const data = z.record(z.string(), z.unknown()).safeParse(JSON.parse(item.output));
    return name && data.success ? [{ name, data: data.data }] : [];
  });
}

/** Advance a leased assignment by one provider operation. The database port
 * fences every transition and stores the response before writing its receipt. */
export async function advanceAssignmentProvider(
  checkpoint: ProviderCheckpoint,
  port: AssignmentProviderPort,
  signal: AbortSignal,
  request?: typeof fetch,
  supersedeOperation?: string,
  stream?: (payload: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<{ type: string; response?: unknown; item?: unknown }>,
  window?: AbortSignal,
): Promise<SavedProviderResponse> {
  if (checkpoint.phase !== "ready" && checkpoint.phase !== "provider_pending") {
    throw new Error("luna_provider_requires_recovered_tool_boundary");
  }
  signal.throwIfAborted();
  const stored = await port.load(checkpoint.sequence);
  const saved = stored == null ? null : savedResponse.parse(stored);
  if (saved && checkpoint.phase === "ready" && saved.operation !== supersedeOperation &&
      checkpoint.lastReceipt === providerReceipt(saved.operation, saved.response.status === "incomplete")) {
    return saved;
  }
  if (checkpoint.phase === "provider_pending" && !checkpoint.operation) {
    throw new Error("luna_provider_missing_operation");
  }
  const operation = checkpoint.operation ?? randomUUID();
  const sequence = checkpoint.phase === "ready" ? await port.begin(checkpoint.sequence, operation) : checkpoint.sequence;
  if (saved?.operation === operation) {
    if (saved.response.status === "incomplete") await port.complete(sequence, operation, true);
    else await port.complete(sequence, operation);
    return saved;
  }

  const { continuation, ...input } = await port.buildRequest(operation, saved);
  const payload = { ...input, stream: true, store: false, include: ["reasoning.encrypted_content"] };
  const serialized = JSON.stringify(payload);
  signal.throwIfAborted();
  const reservation = await port.reserve(payload);
  signal.throwIfAborted();
  reservation.launched();
  const persist = async (response: SavedProviderResponse["response"]) => {
    const state: SavedProviderResponse = { version: 1, operation, response, ...continuation,
      requestBytes: Buffer.byteLength(serialized) };
    await port.save(sequence, state);
    if (response.status === "incomplete") await port.complete(sequence, operation, true);
    else await port.complete(sequence, operation);
    return state;
  };
  let identity: z.infer<typeof responseIdentity> | undefined;
  const finishedItems: z.infer<typeof wireItem>[] = [];
  let terminal: SavedProviderResponse["response"] | undefined;
  try {
    const events = stream ? stream(payload, signal) : streamResponses(input.model, serialized, signal, request);
    for await (const event of events) {
      if (event.type === "response.created") identity = responseIdentity.safeParse(event.response).data;
      if (event.type === "response.output_item.done") {
        const item = wireItem.safeParse(event.item);
        if (item.success) finishedItems.push(item.data);
      }
      if (event.type === "response.completed") {
        terminal = responsesResult.parse(event.response);
        if (terminal.status !== "completed") throw new Error("luna_provider_response_unsettled");
        break;
      }
      if (event.type === "response.incomplete") {
        if (!z.object({ incomplete_details: z.object({ reason: z.literal("max_output_tokens") }) }).safeParse(event.response).success) {
          throw new Error("luna_provider_response_unsettled");
        }
        const response = responsesResult.parse(event.response);
        if (response.status !== "incomplete") throw new Error("luna_provider_response_unsettled");
        terminal = { ...response, output: resumableItems(response.output) };
        break;
      }
      if (event.type === "response.failed" || event.type === "error") throw new Error("luna_provider_response_unsettled");
    }
  } catch (error) {
    if (!window?.aborted || signal.reason !== window.reason || error !== signal.reason) throw error;
  }
  if (terminal) {
    await reservation.complete(terminal, terminal.status);
    if (terminal.status === "completed" || terminal.output.length) return persist(terminal);
  } else if (identity && window?.aborted && signal.reason === window.reason) {
    const output = resumableItems(finishedItems);
    if (output.length) return persist(responsesResult.parse({ ...identity, status: "incomplete", output }));
  }
  throw new Error("luna_provider_response_unsettled");
}
