import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  businessId: "cafe-a", ownerUserId: "owner-a", denied: false,
  where: [] as Array<[string, string]>,
  rows: [] as Array<{ input_tokens: number; output_tokens: number; estimated_cost_micros: number | null }>,
  ranges: [] as Array<[number, number]>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  authenticatedConversationContext: async () => {
    if (mock.denied) throw new Error("forbidden");
    return { scope: { businessId: mock.businessId, ownerUserId: mock.ownerUserId } };
  },
}));
vi.mock("@/lib/ai/conversations/http.server", () => ({
  conversationJson: (value: unknown) => value,
  conversationError: () => ({ error: "forbidden" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => {
      if (table !== "ai_usage_events") throw new Error("wrong table");
      const query = {
        select: () => query,
        eq: (key: string, value: string) => { mock.where.push([key, value]); return query; },
        order: () => query,
        range: async (from: number, to: number) => {
          mock.ranges.push([from, to]);
          return { data: mock.rows.slice(from, to + 1), error: null };
        },
      };
      return query;
    },
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  mock.businessId = "cafe-a"; mock.ownerUserId = "owner-a"; mock.denied = false;
  mock.where = []; mock.rows = []; mock.ranges = [];
});

describe("private Supervisor usage summaries", () => {
  it("never allows a caller-supplied café or owner override", async () => {
    mock.rows = [{ input_tokens: 100, output_tokens: 20, estimated_cost_micros: 65 }];
    const data = await GET();
    expect(data).toMatchObject({ businessId: "cafe-a", requests: 1,
      inputTokens: 100, outputTokens: 20, estimatedCostMicros: 65 });
    expect(mock.where).toEqual([["business_id", "cafe-a"], ["owner_user_id", "owner-a"]]);
  });
  it("denies non-owners before opening a database reader", async () => {
    mock.denied = true;
    expect(await GET()).toMatchObject({ error: "forbidden" });
    expect(mock.ranges).toEqual([]);
  });
  it("paginates beyond Supabase's default row cap instead of undercounting", async () => {
    mock.rows = Array.from({ length: 505 }, () =>
      ({ input_tokens: 10, output_tokens: 5, estimated_cost_micros: 8 }));
    const data = await GET();
    expect(data).toMatchObject({ requests: 505, inputTokens: 5050, outputTokens: 2525,
      estimatedCostMicros: 4040 });
    expect(mock.ranges).toEqual([[0, 499], [500, 999]]);
  });
});
