import { beforeEach, describe, expect, it, vi } from "vitest";

const threadId = "11111111-1111-4111-8111-111111111111";
const businessId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const stub = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, jobsEnabled: true, lookups: [] as string[] }));

vi.mock("@/lib/ai/agent/flags", () => ({
  chatExperienceFlags: () => ({ style: false, jobs: stub.jobsEnabled, memory: false }),
}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  authenticatedConversationContext: async () => ({
    scope: { businessId: "22222222-2222-4222-8222-222222222222", ownerUserId: "33333333-3333-4333-8333-333333333333" },
    service: { getThread: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
  }),
}));
vi.mock("@/lib/ai/conversations/http.server", () => ({
  parseInput: (_schema: unknown, value: string) => value,
  conversationJson: (body: unknown) => Response.json(body),
  conversationError: (error: unknown) => { throw error; },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => {
      if (table !== "ai_agent_jobs") throw new Error("unexpected table");
      let rows = [...stub.rows];
      const q = {
        select: (_columns: string) => q,
        eq: (column: string, value: unknown) => {
          if (column === "status") stub.lookups.push(String(value));
          rows = rows.filter(r => r[column] === value);
          return q;
        },
        in: (column: string, values: string[]) => {
          rows = rows.filter(r => values.includes(String(r[column])));
          return q;
        },
        order: (column: string, options: { ascending: boolean }) => {
          rows.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0)
            * (options.ascending ? 1 : -1));
          return q;
        },
        limit: (count: number) => { rows = rows.slice(0, count); return q; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return q;
    },
  }),
}));
import { GET } from "./route";

const job = (id: string, status: "running" | "failed" | "done", created: string) => ({
  id, business_id: businessId, thread_id: threadId, owner_user_id: ownerId,
  owner_message_id: "44444444-4444-4444-8444-444444444444", status, attempt: 1,
  error_code: status === "failed" ? "timeout" : null, reply_message_id: null,
  progress: [], inbox: [], consumed: [], heartbeat_at: new Date().toISOString(), created_at: created,
});
const request = async () => (await GET(new Request("http://localhost:3000/api/ai/threads/" + threadId + "/jobs"),
  { params: Promise.resolve({ threadId }) })).json() as Promise<{ job: { id: string; status: string } | null }>;

beforeEach(() => { stub.rows = []; stub.jobsEnabled = true; stub.lookups = []; });

describe("GET /jobs priority", () => {
  it("returns an older running retry before a newer terminal job", async () => {
    stub.rows = [
      job("55555555-5555-4555-8555-555555555555", "running", "2026-10-20T00:00:00.000Z"),
      job("66666666-6666-4666-8666-666666666666", "done", "2026-10-23T00:00:00.000Z"),
    ];
    const result = await request();
    expect(result.job?.id).toBe("55555555-5555-4555-8555-555555555555");
    expect(result.job?.status).toBe("running");
    expect(stub.lookups).toEqual(["running"]);
  });

  it("returns the most recent terminal job if none are running", async () => {
    stub.rows = [
      job("55555555-5555-4555-8555-555555555555", "failed", "2026-10-20T00:00:00.000Z"),
      job("66666666-6666-4666-8666-666666666666", "done", "2026-10-23T00:00:00.000Z"),
    ];
    const result = await request();
    expect(result.job?.id).toBe("66666666-6666-4666-8666-666666666666");
    expect(stub.lookups).toEqual(["running"]);
  });

  it("returns no job without querying the table when the flag is off", async () => {
    stub.jobsEnabled = false;
    expect((await request()).job).toBeNull();
    expect(stub.lookups).toEqual([]);
  });
});
