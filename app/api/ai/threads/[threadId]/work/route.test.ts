import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  authenticatedConversationContext: auth,
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: client }));

import { GET } from "./route";

const thread = "123e4567-e89b-42d3-a456-426614174000";
function database() {
  const filters: Record<string, Array<[string, string, unknown]>> = {};
  const source: Record<string, unknown[]> = {
    supervisor_runs: [], supervisor_run_steps: [], ai_agent_jobs: [],
    supervisor_proposals: [], supervisor_effect_attempts: [], supervisor_investigations: [],
  };
  const db = { from(table: string) {
    const query = {
      select() { return query; },
      eq(field: string, value: unknown) { (filters[table] ??= []).push(["eq", field, value]); return query; },
      in(field: string, value: unknown) { (filters[table] ??= []).push(["in", field, value]); return query; },
      order() { return query; }, limit() { return query; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve({ data: source[table] ?? [], error: null })); },
    };
    return query;
  } };
  return { db, filters, source };
}
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ scope: { businessId: "cafe-a", ownerUserId: "owner-a" },
    service: { getThread: vi.fn().mockResolvedValue({ id: thread }) } });
});
describe("GET /work owner isolation and receipt verification", () => {
  it("uses business, owner and thread scope on every top-level ledger", async () => {
    const { db, filters } = database();
    client.mockResolvedValue(db);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.work).toEqual([]);
    for (const table of ["supervisor_runs", "supervisor_proposals", "supervisor_investigations"]) {
      expect(filters[table]).toEqual(expect.arrayContaining([
        ["eq", "business_id", "cafe-a"], ["eq", "owner_user_id", "owner-a"],
        ["eq", "thread_id", thread],
      ]));
    }
    expect(filters.ai_agent_jobs).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["eq", "owner_user_id", "owner-a"],
      ["eq", "thread_id", thread],
    ]));
    expect(filters.supervisor_run_steps).toBeUndefined();
    expect(filters.supervisor_effect_attempts).toBeUndefined();
  });
  it("scopes nested steps/effects by business and IDs read from the authorized conversation", async () => {
    const { db, filters, source } = database();
    source.supervisor_runs = [{ id: "run-a", request_key: "owner-message", status: "running", final_report_ref: null,
      updated_at: "2026-11-14T10:00:00Z", finished_at: null }];
    source.supervisor_proposals = [{ id: "proposal-a", capability_id: "purchase", status: "draft",
      effect_hash: "hash-a", updated_at: "2026-11-14T10:00:00Z" }];
    client.mockResolvedValue(db);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).toBe(200);
    expect(filters.supervisor_run_steps).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["in", "run_id", ["run-a"]],
    ]));
    expect(filters.supervisor_effect_attempts).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["in", "proposal_id", ["proposal-a"]],
    ]));
  });
  it("never leaks work after a thread lookup denies ownership", async () => {
    const { db } = database();
    client.mockResolvedValue(db);
    const scope = await auth();
    scope.service.getThread.mockRejectedValue(new Error("not_owner"));
    auth.mockResolvedValue(scope);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).not.toBe(200);
    expect(client).not.toHaveBeenCalled();
  });
});
