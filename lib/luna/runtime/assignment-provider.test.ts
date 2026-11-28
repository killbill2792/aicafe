import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { advanceAssignmentProvider, type AssignmentProviderPort } from "./assignment-provider.server";
import * as assignmentProvider from "./assignment-provider.server";
import { processLunaAssignment } from "./assignment-worker.server";

const ready = { phase: "ready", sequence: 0, operation: null, lastReceipt: null } as const;
const response = {
  id: "resp_test", status: "completed", usage: { input_tokens: 42, output_tokens: 10 },
  output: [
    { type: "reasoning", encrypted_content: "opaque" },
    { type: "function_call", call_id: "call_test", name: "read_sales", arguments: "{}" },
    { type: "message", content: [{ type: "output_text", text: "Sales rose 8%." }] },
  ],
} as const;

function dependencies() {
  const reservation = { launched: vi.fn(), complete: vi.fn(async () => undefined) };
  const port = {
    load: vi.fn<AssignmentProviderPort["load"]>(async () => null),
    begin: vi.fn(async () => 1),
    buildRequest: vi.fn(async () => ({ model: "test-model", instructions: "Answer the owner.", input: [], tools: [], max_output_tokens: 100 })),
    reserve: vi.fn(async () => reservation), save: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  } satisfies AssignmentProviderPort;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
    `data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
  ));
  return { port, fetch, reservation, signal: new AbortController().signal };
}

it("reserves before dispatch and persists the original response before its checkpoint receipt", async () => {
  const { port, fetch, reservation, signal } = dependencies();
  const state = await advanceAssignmentProvider(ready, port, signal, fetch);
  expect(state.response).toEqual(response);
  expect(port.reserve).toHaveBeenCalledBefore(fetch);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    store: false, stream: true, include: ["reasoning.encrypted_content"],
  });
  expect(port.save).toHaveBeenCalledWith(1, state);
  expect(reservation.complete).toHaveBeenCalledBefore(port.save);
  expect(port.save).toHaveBeenCalledBefore(port.complete);
  expect(port.complete).toHaveBeenCalledWith(1, state.operation);
});

it("reuses a persisted response after a lease ends or its checkpoint receipt already committed", async () => {
  const { port, fetch, signal } = dependencies();
  const operation = randomUUID(), state = { version: 1, operation, response };
  port.load.mockResolvedValue(state);
  expect(await advanceAssignmentProvider({ ...ready, phase: "provider_pending", sequence: 9, operation }, port, signal, fetch)).toEqual(state);
  expect(port.complete).toHaveBeenCalledWith(9, operation);
  expect(await advanceAssignmentProvider({ ...ready, sequence: 10, lastReceipt: `provider:${operation}` }, port, signal, fetch)).toEqual(state);
  expect(port.complete).toHaveBeenCalledTimes(1);
  expect(port.reserve).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("treats denied reservations and incomplete responses as unsettled work", async () => {
  const { port, fetch, signal } = dependencies();
  port.reserve.mockRejectedValueOnce(new Error("owner quota denied"));
  await expect(advanceAssignmentProvider(ready, port, signal, fetch)).rejects.toThrow("owner quota denied");
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(new Response('data: {"type":"response.incomplete"}\n\n'));
  await expect(advanceAssignmentProvider(ready, port, signal, fetch)).rejects.toThrow("luna_provider_response_unsettled");
  expect(port.save).not.toHaveBeenCalled();
  expect(port.complete).not.toHaveBeenCalled();
});

it("does not restart a provider while a tool boundary still needs recovery", async () => {
  const { port, fetch, signal } = dependencies();
  await expect(advanceAssignmentProvider({ ...ready, phase: "effect_pending" }, port, signal, fetch))
    .rejects.toThrow("luna_provider_requires_recovered_tool_boundary");
  expect(port.load).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("offers scoped metadata discovery and reports absent direct transport", async () => {
  vi.stubEnv("SUPERVISOR_RESEARCH_DATABASE_URL", undefined);
  const workerProvider = vi.spyOn(assignmentProvider, "runClaimedAssignmentProvider").mockResolvedValue(null);
  try {
    const scope = { businessId: randomUUID(), ownerUserId: randomUUID(), threadId: randomUUID() };
    const runId = randomUUID(), claimToken = randomUUID();
    const budget = { maxElapsedMs: 1000, maxModelCalls: 2, maxToolCalls: 1, maxInputTokens: 4000, maxOutputTokens: 100 };
    const rpc = vi.fn(async () => ({ kind: "claimed", idempotency_key: runId, step: {
      step_key: "owner_turn", retry_mode: "idempotent", claim_token: claimToken, lease_until: new Date().toISOString(), attempts: 1,
    } }));
    await expect(processLunaAssignment({ scope, runId, rpc, signal: new AbortController().signal,
      accounting: { db: { rpc: vi.fn() }, budget, ownerDailyCap: null, authorize: vi.fn() },
      buildRequest: vi.fn(),
    })).resolves.toBe("busy");
    const [{ lease, readTools, signal }] = workerProvider.mock.calls[0];
    expect(readTools?.map(tool => tool.definition.name)).toEqual(["calculate", "describe_database"]);
    const metadata = readTools!.find(tool => tool.definition.name === "describe_database")!;
    const context = { ...lease, jobId: randomUUID(), ownerMessageId: randomUUID(), employeeKey: "general_manager" as const,
      originalInput: { text: "Describe the catalog.", receivedAt: new Date().toISOString(), locale: "en" as const, attachmentIds: [] } };
    await expect(metadata.execute(context, { tables: null }, signal)).resolves.toEqual({ ok: false, error: "research_database_connection_unavailable" });
    await expect(metadata.execute(context, { tables: null, businessId: randomUUID() }, signal)).resolves.toEqual({ ok: false, error: "invalid_tool_arguments" });
  } finally {
    workerProvider.mockRestore();
    vi.unstubAllEnvs();
  }
});
