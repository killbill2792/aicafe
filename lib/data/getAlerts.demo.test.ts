import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  businessId: "owner-cafe",
  generate: vi.fn(async (..._args: unknown[]) => ({ created: 0 })),
  queries: [] as { table: string; businessId?: string; statuses?: string[] }[],
}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn(async () => m.businessId) }));
vi.mock("@/lib/alerts/generate", () => ({ generateAlerts: m.generate }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from: (table: string) => {
      const query: { table: string; businessId?: string; statuses?: string[] } = { table };
      m.queries.push(query);
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => { if (column === "business_id") query.businessId = value; return builder; },
        in: (column: string, values: string[]) => { if (column === "status") query.statuses = values; return builder; },
        order: async () => ({ data: [], error: null }),
      };
      return builder;
    },
  })),
}));
import { getOpenAlerts } from "./getAlerts";

beforeEach(() => {
  m.generate.mockClear();
  m.queries.length = 0;
  m.businessId = "owner-cafe";
});

describe("shared demo alert listing", () => {
  it("shows demo alerts without triggering global alert generation", async () => {
    m.businessId = DEMO_BUSINESS_ID;
    expect(await getOpenAlerts()).toEqual([]);
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.queries).toEqual([{ table: "alerts", businessId: DEMO_BUSINESS_ID, statuses: ["new", "seen"] }]);
  });

  it("continues generating alerts for an owner's own café", async () => {
    expect(await getOpenAlerts()).toEqual([]);
    expect(m.generate).toHaveBeenCalledOnce();
    expect(m.generate.mock.calls[0]?.[1]).toBe("owner-cafe");
  });
});
