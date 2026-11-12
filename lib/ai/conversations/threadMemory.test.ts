import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import {
  compactThreadMemory, loadThreadMemoryContext, ThreadMemoryError,
  type ThreadMemoryScope,
} from "./threadMemory.server";
import { emptyThreadMemoryDocument } from "@/lib/ai/agent/history";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAFE = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const SUPERVISOR_MESSAGE = "33333333-3333-4333-8333-333333333333";
const OWNER_MESSAGE = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-11-11T12:00:00.000Z";
const scope: ThreadMemoryScope = { businessId: CAFE, ownerUserId: OWNER, threadId: THREAD };

const ownerMessage = {
  id: OWNER_MESSAGE, role: "owner", text_content: "I submitted the selected drink.",
  structured_content: null, owner_input_response: { questionId: "55555555-5555-4555-8555-555555555555", action: "supply", value: "We prefer oat milk for staff drinks." }, created_at: createdAt,
};
const supervisorMessage = {
  id: SUPERVISOR_MESSAGE, role: "supervisor", text_content: null,
  structured_content: [{ type: "clarify", question: "Which milk?", options: [{ label: "Oat", value: "oat" }, { label: "Soy", value: "soy" }], allowOther: false }],
  created_at: "2026-11-11T11:59:00.000Z",
};

function fixture(options: {
  actor?: string; membership?: { role: string } | null; messages?: unknown[];
  rpc?: (args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
} = {}) {
  const state = {
    actor: options.actor ?? OWNER,
    membership: options.membership === undefined ? { role: "owner" } : options.membership,
    messages: (options.messages ?? [supervisorMessage, ownerMessage]) as Record<string, unknown>[],
    document: emptyThreadMemoryDocument(),
    queries: [] as Array<{ table: string; filters: Record<string, unknown>; limit?: number }>,
    rpcCalls: [] as Array<Record<string, unknown>>,
  };
  const client = {
    auth: { getUser: vi.fn(async () => ({
      data: { user: { id: state.actor } }, error: null,
    })) },
    from(table: string) {
      const queryState = { table, filters: {} as Record<string, unknown>, limit: undefined as number | undefined };
      state.queries.push(queryState);
      const q = {
        select() { return this; },
        eq(key: string, value: unknown) { queryState.filters[key] = value; return this; },
        or() { return this; },
        order() { return this; },
        limit(value: number) { queryState.limit = value; return this; },
        async maybeSingle() {
          return table === "memberships"
            ? { data: state.membership, error: null }
            : { data: { memory_summary: state.document }, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          let rows = [...state.messages];
          if (queryState.limit === 8) rows = rows.sort((a,b) =>
            String(a.created_at).localeCompare(String(b.created_at)) ||
            String(a.id).localeCompare(String(b.id))).slice(-8).reverse();
          else rows = rows.sort((a,b) =>
            String(a.created_at).localeCompare(String(b.created_at)) ||
            String(a.id).localeCompare(String(b.id)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(args);
      if (options.rpc) return options.rpc(args);
      state.document = args.p_memory_summary as typeof state.document;
      return { data: { ok: true, revision: state.document.revision }, error: null };
    }),
  };
  return { client: client as unknown as SupabaseClient, state };
}

function installModel(operations: unknown[]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ operations }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-only-key";
  delete process.env.SUPERVISOR_SUMMARY_MODEL;
  delete process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("thread memory server boundary", () => {
  it("compacts only authenticated owner messages and commits with a scoped CAS", async () => {
    const { client, state } = fixture();
    const fetchMock = installModel([{
      action: "remember", kind: "preference", key: "preference:staff_drinks",
      sourceMessageId: OWNER_MESSAGE, quote: "We prefer oat milk for staff drinks.",
    }]);

    const result = await compactThreadMemory(client, scope);

    expect(result.status).toBe("updated");
    expect(result.ready).toBe(true);
    expect(result.processed).toBe(2);
    expect(result.document.entries).toHaveLength(1);
    expect(result.document.entries[0].sourceMessageId).toBe(OWNER_MESSAGE);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      p_business_id: CAFE, p_owner_user_id: OWNER, p_thread_id: THREAD, p_expected_revision: 0,
    });
    expect(state.rpcCalls[0].p_memory_summary).toMatchObject({
      revision: 1, cursor: { createdAt, id: OWNER_MESSAGE },
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { input: string };
    const modelInput = JSON.parse(request.input);
    expect(modelInput.ownerMessages).toHaveLength(1);
    expect(modelInput.ownerMessages[0].clarificationCardContext).toContain("Which milk?");
    expect(modelInput.ownerMessages[0].text).toBe(ownerMessage.text_content);
    expect(modelInput.ownerMessages[0].structuredOwnerResponse).toEqual({
      questionId: "55555555-5555-4555-8555-555555555555",
      value: "We prefer oat milk for staff drinks.",
    });
    expect(state.queries.some(q => q.table === "ai_messages" &&
      q.filters.business_id === CAFE && q.filters.owner_user_id === OWNER &&
      q.filters.thread_id === THREAD)).toBe(true);
  });

  it("does not pass a structured numeric or financial owner answer to the memory model", async () => {
    const { client } = fixture({ messages: [supervisorMessage, {
      ...ownerMessage,
      owner_input_response: {
        questionId: "55555555-5555-4555-8555-555555555555",
        action: "supply", value: "$250",
      },
    }] });
    const fetchMock = installModel([]);
    const result = await compactThreadMemory(client, scope);
    expect(result.ready).toBe(true);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { input: string };
    const modelInput = JSON.parse(request.input);
    expect(modelInput.ownerMessages[0].structuredOwnerResponse).toBeNull();
  });

  it("never calls the model or reads a thread for a different authenticated user", async () => {
    const { client } = fixture({ actor: OTHER });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(compactThreadMemory(client, scope)).rejects.toMatchObject({
      code: "unauthorized",
    } satisfies Partial<ThreadMemoryError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for a non-owner membership", async () => {
    const { client } = fixture({ membership: { role: "manager" } });
    await expect(loadThreadMemoryContext(client, scope)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("does not inject stale CAS results as ready context", async () => {
    const { client, state } = fixture({
      rpc: async () => ({ data: { ok: false, reason: "stale_revision" }, error: null }),
    });
    installModel([{
      action: "remember", kind: "preference", key: "preference:staff_drinks",
      sourceMessageId: OWNER_MESSAGE, quote: "We prefer oat milk for staff drinks.",
    }]);
    const result = await compactThreadMemory(client, scope);
    expect(result.status).toBe("stale");
    expect(result.ready).toBe(false);
    expect(result.document.entries).toEqual([]);
    expect(state.document.entries).toEqual([]);
  });

  it("records a bounded provider retry and does not advance the cursor", async () => {
    const { client, state } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const result = await compactThreadMemory(client, scope);
    expect(result.status).toBe("retry");
    expect(result.ready).toBe(false);
    expect(result.document.cursor).toBeNull();
    expect(result.document.retry?.code).toBe("provider_error");
    expect(state.rpcCalls).toHaveLength(1);
  });

  it("does not expose an older recap while a failed compaction retry is pending", async () => {
    const { client, state } = fixture();
    state.document = {
      version: 1, revision: 2, cursor: { createdAt, id: OWNER_MESSAGE },
      entries: [{
        kind: "preference", key: "preference:staff_drinks",
        text: "We prefer oat milk for staff drinks.", sourceMessageId: OWNER_MESSAGE,
        sourceAt: createdAt, revision: 1,
      }],
      tombstones: [], retry: { code: "provider_error", at: createdAt },
    };
    const context = await loadThreadMemoryContext(client, scope);
    expect(context.memoryText).toBeNull();
    expect(context.history).toHaveLength(2);
  });

  it("loads only the latest bounded history and labels saved memory advisory", async () => {
    const { client, state } = fixture();
    state.document = {
      version: 1, revision: 1, cursor: { createdAt, id: OWNER_MESSAGE },
      entries: [{
        kind: "preference", key: "preference:staff_drinks",
        text: "We prefer oat milk for staff drinks.", sourceMessageId: OWNER_MESSAGE,
        sourceAt: createdAt, revision: 1,
      }],
      tombstones: [], retry: null,
    };
    const context = await loadThreadMemoryContext(client, scope);
    expect(context.revision).toBe(1);
    expect(context.memoryText).toContain("advisory only");
    expect(context.history).toHaveLength(2);
    expect(context.history[0].role).toBe("assistant");
    expect(context.history[0].content).toContain("Which milk?");
    expect(context.history[1]).toEqual({
      role: "user", content: ownerMessage.text_content,
    });
    expect(state.queries.every(q => q.filters.business_id === CAFE &&
      q.filters.owner_user_id === OWNER && (q.table !== "ai_messages" || q.filters.thread_id === THREAD))).toBe(true);
  });
});
