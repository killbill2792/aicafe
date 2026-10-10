import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { supervisorFactReaders } from "./supervisorFacts.server";

type Result = { data: unknown; error: null };
function query(result: Result) {
  const q = {
    select: () => q, eq: () => q, is: () => q,
    gte: () => q, lte: () => q, not: () => q,
    then: (resolve: (value: Result) => void) => Promise.resolve(result).then(resolve),
  };
  return q;
}

describe("Supervisor owner-scoped facts", () => {
  it("reconciles monthly recurring bills with the exact Bills screen helper", async () => {
    const rows = [
      { amount_cents: 700_000, frequency: "monthly", is_estimate: false },
      { amount_cents: 120_000, frequency: "yearly", is_estimate: true },
    ];
    const client = { from: vi.fn(() => query({ data: rows, error: null })) } as unknown as SupabaseClient;
    const reader = supervisorFactReaders(client, "cafe-a");
    const result = await reader.monthlyBills("cafe-a");
    expect(result).toMatchObject({
      available: true, value: { totalCents: 710_000 },
      quality: { estimatedInputs: ["recurringBills"] },
    });
    expect(client.from).toHaveBeenCalledWith("recurring_costs");
  });

  it("counts only recorded actual entries, not estimated or recurring schedules", async () => {
    const client = { from: vi.fn(() => query({ data: [
      { amount_cents: 20_000, status: "actual" },
      { amount_cents: 10_000, status: "estimated" },
    ], error: null })) } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").recordedExpenses("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: true, value: { totalCents: 20_000 } });
    expect(client.from).toHaveBeenCalledWith("expenses");
  });

  it("does not promote item quantities to complete totals without verified backfill", async () => {
    const client = { from: vi.fn(() => query({ data: [], error: null })), rpc: vi.fn() } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").productSales("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: false, quality: { missingInputs: ["itemSalesCoverage"] } });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("obtains date-scoped quantities through the invoker-RLS RPC with all menu items", async () => {
    const client = {
      from: vi.fn((table: string) => query({ data: table === "pos_connections"
        ? [{ last_synced_at: "2026-10-10T23:00:00Z", backfill_completed_at: "2026-10-01T20:00:00Z" }]
        : [{ id: "one", name: "Latte", category: "drink" }, { id: "two", name: "Muffin", category: "food" }],
      error: null })),
      rpc: vi.fn(async () => ({ data: [{ menu_item_id: "one", total_quantity: 19 }], error: null })),
    } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").productSales("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: true, value: [
      { id: "one", units: 19 }, { id: "two", units: 0 },
    ] });
    expect(client.rpc).toHaveBeenCalledWith("menu_item_quantities_sold", {
      p_business_id: "cafe-a", p_from: "2026-10-01", p_to: "2026-10-10",
    });
  });

  it("denies cross-café and empty identifiers before hitting any database reader", async () => {
    const client = { from: vi.fn(), rpc: vi.fn() } as unknown as SupabaseClient;
    const readers = supervisorFactReaders(client, "cafe-a");
    await expect(readers.monthlyBills("cafe-b")).rejects.toThrow("scope mismatch");
    await expect(readers.recordedExpenses("", { from: "2026-10-01", to: "2026-10-10" }))
      .rejects.toThrow("scope mismatch");
    await expect(readers.productSales("cafe-b", { from: "2026-10-01", to: "2026-10-10" }))
      .rejects.toThrow("scope mismatch");
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
