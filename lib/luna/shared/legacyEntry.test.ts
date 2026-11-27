import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { openAIProvider } from "@/lib/ai/agent/loop.server";
import { processDurableRun } from "@/lib/ai/supervisor/runs/worker.server";
import { ProviderAvailabilityError, streamResponses, type ResponsesEvent } from "./responses.server";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ from }) }));
afterEach(() => {
  from.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["pending", "running", "blocked", "completed"])("legacy entry detaches from a %s replacement run before any work", async status => {
  const id = randomUUID();
  const row = { id, business_id: randomUUID(), owner_user_id: randomUUID(), thread_id: randomUUID(),
    request_key: randomUUID(), status, engine: "replacement", execution_version: 2 };
  const select = vi.fn(() => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }));
  from.mockReturnValueOnce({ select });
  expect(await processDurableRun(id)).toBe("busy");
  expect(select.mock.calls.flat().join(",").split(",")).toContain("engine");
  expect(from.mock.calls).toEqual([["supervisor_runs"]]);
});

async function collect(events: AsyncIterable<ResponsesEvent>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}

it("uses the same Responses transport, abort signal and stream framing after the legacy budget gate", async () => {
  vi.stubEnv("AICAFE_TASK14B_BUDGET_LEDGER", "");
  vi.stubEnv("OPENAI_API_KEY", "disposable");
  const signal = new AbortController().signal;
  const params = { model: "deterministic-test-model", stream: true };
  const event = { type: "response.output_text.delta", delta: "café" };
  const request = vi.fn<typeof fetch>(async () => {
    const bytes = new TextEncoder().encode("data: " + JSON.stringify(event) + "\r\n\r\ndata: [DONE]\n\n");
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
  });
  vi.stubGlobal("fetch", request);
  expect(await collect(openAIProvider(params, signal))).toEqual([event]);
  expect(await collect(streamResponses(params.model, JSON.stringify(params), signal, request))).toEqual([event]);
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({ method: "POST", signal, body: JSON.stringify(params),
      headers: { Authorization: "Bearer disposable", "Content-Type": "application/json" } });
  }
  request.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await expect(collect(openAIProvider(params, signal))).rejects.toBeInstanceOf(ProviderAvailabilityError);
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(collect(openAIProvider(params, signal))).rejects.toThrow("provider_error");
});
