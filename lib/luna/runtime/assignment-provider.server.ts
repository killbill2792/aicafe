import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  loadModelExecutionCap, reserveDurableProviderRequest, withDurableProviderTurn, type DurableProviderScope,
} from "@/lib/ai/supervisor/runs/provider-reservation.server";
import { streamResponses } from "../shared/responses.server";
import { employeeKeys, type EmployeeKey } from "../workforce/roster";

const completedResponse = z.object({
  id: z.string().min(1),
  status: z.literal("completed"),
  output: z.array(z.looseObject({ type: z.string().min(1) })),
  model: z.string().optional(),
  service_tier: z.string().nullish(),
  usage: z.unknown().optional(),
});

const savedResponse = z.object({
  version: z.literal(1),
  operation: z.uuid(),
  response: completedResponse,
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
  max_output_tokens: number;
};

export type AssignmentProviderPort = {
  load: (sequence: number) => Promise<unknown>;
  begin: (sequence: number, operation: string) => Promise<number>;
  buildRequest: (operation: string) => Promise<ProviderRequest>;
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

/** Both interactive and scheduled dispatch can pass their existing owner-turn
 * lease here. Only the scoped request builder selects inputs and capabilities. */
export async function runClaimedAssignmentProvider({
  lease, rpc, signal, request, buildRequest, accounting,
}: {
  lease: AssignmentLease;
  rpc: Rpc;
  signal: AbortSignal;
  request?: typeof fetch;
  buildRequest: (context: ProviderContext, steering: z.infer<typeof steeringPage>) => Promise<ProviderRequest>;
  accounting: AssignmentAccounting;
}): Promise<{ jobId: string; ownerMessageId: string; sequence: number; result: SavedProviderResponse } | null> {
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
  const checkpoint = (sequence: number, operation: string, receipt: string | null) =>
    rpc("supervisor_checkpoint_owner_run_v2", {
      ...scope, p_expected_seq: sequence, p_operation: operation,
      p_action: receipt ? "complete" : "begin_provider", p_tool: null, p_receipt_ref: receipt,
    });
  const checkpointSequence = z.object({ checkpoint_seq: z.number().int().nonnegative() });
  let settledSequence = entry.sequence;
  const result = await advanceAssignmentProvider(entry, {
    load: (sequence) => rpc("supervisor_research_checkpoint_v2", {
      ...scope, p_expected_seq: sequence, p_write: false, p_state: null,
    }),
    begin: async (sequence, operation) => checkpointSequence
      .parse(await checkpoint(sequence, operation, null)).checkpoint_seq,
    buildRequest: async (operation) => {
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
      return buildRequest(context, steering);
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
    save: async (sequence, state) => {
      if (await rpc("supervisor_research_checkpoint_v2", {
        ...scope, p_expected_seq: sequence, p_write: true, p_state: state,
      }) !== true) throw new Error("luna_provider_checkpoint_not_saved");
    },
    complete: async (sequence, operation) => {
      settledSequence = checkpointSequence.parse(await checkpoint(sequence, operation, `provider:${operation}`)).checkpoint_seq;
    },
  }, signal, request);
  return { jobId: context.jobId, ownerMessageId: context.ownerMessageId, sequence: settledSequence, result };
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

  const input = await port.buildRequest(operation);
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
    const state = { version: 1 as const, operation, response };
    await port.save(sequence, state);
    await port.complete(sequence, operation);
    return state;
  }
  throw new Error("luna_provider_response_unsettled");
}
