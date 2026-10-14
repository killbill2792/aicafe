import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compensation: [] as Array<Record<string, unknown>>,
  wages: [] as Array<Record<string, unknown>>,
  requestedWages: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  readQueries: [] as Array<{ table: string; cursor: string | null; size: number }>,
  apiMaxRows: null as number | null,
  rpc: vi.fn(),
  activeBusinessId: "10000000-0000-4000-8000-000000000001",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({
  getActiveBusinessId: async () => mocks.activeBusinessId,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({
      data: { user: { id: "20000000-0000-4000-8000-000000000002" } },
      error: null,
    }) },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
    from: (table: string) => {
      if (table === "memberships") return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({
            data: { role: "owner", businesses: { is_demo: false } }, error: null,
          }),
        }) }) }) }),
      };
      if (table === "employees") return {
        select: (fields: string) => {
          mocks.requestedWages(fields);
          return { eq: () => ({ in: async (_key: string, ids: string[]) => ({
            data: mocks.wages.filter((row) => ids.includes(String(row.id))), error: null,
          }) }) };
        },
      };
      return {
        select: () => ({ eq: () => ({ order: () => ({
          limit: (size: number) => {
            const all = (table === "staff_scheduling_compensation"
              ? mocks.compensation : mocks.tables[table] ?? [])
              .slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
            const getPage = (cursor: string | null) => {
              mocks.readQueries.push({ table, cursor, size });
              const remaining = all.filter((row) => cursor === null || String(row.id) > cursor);
              return Promise.resolve({
                data: remaining.slice(0, Math.min(size, mocks.apiMaxRows ?? size)),
                error: null, count: remaining.length,
              });
            };
            return {
              gt: (_key: string, cursor: string) => getPage(cursor),
              then: (resolve: (result: Awaited<ReturnType<typeof getPage>>) => unknown) =>
                getPage(null).then(resolve),
            };
          },
        }) }) }),
      };
    },
  }),
}));

import { executeFoundationCommand, readSchedulingFoundation } from "./foundation.server";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("scheduling foundation compensation read is fail closed", () => {
  beforeEach(() => {
    mocks.compensation = [];
    mocks.wages = [];
    mocks.requestedWages.mockClear();
    mocks.tables = {};
    mocks.readQueries = [];
    mocks.apiMaxRows = null;
    mocks.rpc.mockReset();
    mocks.activeBusinessId = "10000000-0000-4000-8000-000000000001";
    process.env.SCHEDULING_FOUNDATION_ENABLED = "true";
  });

  it("invalidates negative cached/amount fields for EVERY trusted state on read", async () => {
    const cases = [
      { state: "known_eligible_zero", amount: -1, hourly: 0 },
      { state: "known_eligible_zero", amount: 0, hourly: -1 },
      { state: "known_paid", amount: 1800, hourly: -1 },
      { state: "salary_conversion_pending", amount: 200000, hourly: -1, period: "month" },
    ];
    mocks.compensation = cases.map((row, i) => ({
      id: id(i + 200), employee_id: id(i), cash_cost_state: row.state,
      eligibility_reference: "Outdated evidence", eligibility_verified_by: id(90),
      eligibility_verified_at: "2026-10-14T00:00:00Z",
    }));
    mocks.wages = cases.map((row, i) => ({
      id: id(i), wage_period: row.period ?? "hour",
      wage_amount_cents: row.amount, default_hourly_wage_cents: row.hourly,
    }));
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect(result.records.compensation).toHaveLength(4);
    for (const row of result.records.compensation as Array<Record<string, unknown>>) {
      expect(row).toMatchObject({
        cash_cost_state: "unknown", eligibility_reference: null,
        eligibility_verified_by: null, eligibility_verified_at: null,
      });
    }
    // No source compensation mutation: read guard only sanitizes the result.
    expect(mocks.compensation[0].cash_cost_state).toBe("known_eligible_zero");
    expect(mocks.requestedWages).toHaveBeenCalledWith(
      "id,wage_period,wage_amount_cents,default_hourly_wage_cents",
    );
  });

  it("retains valid known states for null/zero, positive and salary-pending wages", async () => {
    const cases = [
      { state: "known_eligible_zero", period: "hour", amount: null, hourly: null },
      { state: "known_eligible_zero", period: "hour", amount: 0, hourly: 0 },
      { state: "known_paid", period: "hour", amount: 1800, hourly: 1800 },
      { state: "salary_conversion_pending", period: "month", amount: 200000, hourly: 0 },
      { state: "unknown", period: "hour", amount: -1, hourly: 0 },
    ];
    mocks.compensation = cases.map((row, i) => ({
      id: id(i + 200), employee_id: id(i), cash_cost_state: row.state,
    }));
    mocks.wages = cases.map((row, i) => ({
      id: id(i), wage_period: row.period,
      wage_amount_cents: row.amount, default_hourly_wage_cents: row.hourly,
    }));
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect((result.records.compensation as Array<{ cash_cost_state: string }>)
      .map((row) => row.cash_cost_state))
      .toEqual(cases.map((row) => row.state));
  });

  it("does not expose verified zero for a missing or malformed wage snapshot", async () => {
    mocks.compensation = [
      { id: id(201), employee_id: id(1), cash_cost_state: "known_eligible_zero" },
      { id: id(202), employee_id: id(2), cash_cost_state: "known_paid" },
      { id: id(203), employee_id: id(3), cash_cost_state: "salary_conversion_pending" },
    ];
    mocks.wages = [
      { id: id(2), wage_period: "hour", wage_amount_cents: "1800", default_hourly_wage_cents: 1800 },
      { id: id(3), wage_period: "month", wage_amount_cents: 200000, default_hourly_wage_cents: "0" },
    ];
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect((result.records.compensation as Array<{ cash_cost_state: string }>)
      .map((row) => row.cash_cost_state))
      .toEqual(["unknown", "unknown", "unknown"]);
  });

  it("rejects immutable shared demo tenant even if its mutable is_demo flag is false", async () => {
    mocks.activeBusinessId = "11111111-1111-1111-1111-111111111111";
    expect(await readSchedulingFoundation()).toEqual({ ok: false, error: "unauthorized" });
    const data = { employee_id: id(1), day_of_week: 3,
      start_local: "07:00", end_local: "11:00", overnight: false,
      effective_from: "2026-10-14", source: "owner_direct", confirmation: "owner_confirmed" };
    expect(await executeFoundationCommand({
      kind: "availability_rule", action: "create", requestKey: id(400), data,
    })).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("loads all 1,205 tenant rows across three stable pages with no omission", async () => {
    const rows = Array.from({ length: 1205 }, (_, i) => ({
      id: id(i + 1), business_id: "10000000-0000-4000-8000-000000000001",
      start_local: "07:00:00", end_local: "11:00:00", overnight: false,
    }));
    mocks.tables.staff_availability_rules = rows;
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("read failed");
    expect(result.records.availability_rule).toHaveLength(1205);
    expect((result.records.availability_rule[0] as { start_local: string }).start_local)
      .toBe("07:00");
    expect(mocks.readQueries.filter((q) => q.table === "staff_availability_rules"))
      .toEqual([
        { table: "staff_availability_rules", cursor: null, size: 500 },
        { table: "staff_availability_rules", cursor: id(500), size: 500 },
        { table: "staff_availability_rules", cursor: id(1000), size: 500 },
      ]);
  });

  it("fails closed if the backend silently caps a requested 500-row page", async () => {
    mocks.tables.staff_availability_rules = Array.from({ length: 510 }, (_, i) => ({
      id: id(i + 1), start_local: "09:00:00", end_local: "17:00:00",
    }));
    // Server pagination must use count:exact and return all 510 rows.
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("read failed");
    expect(result.records.availability_rule).toHaveLength(510);
  });

  it("returns storage_unavailable rather than silently truncating at a lower API row cap", async () => {
    mocks.apiMaxRows = 100;
    mocks.tables.staff_availability_rules = Array.from({ length: 220 }, (_, i) => ({
      id: id(i + 1), start_local: "09:00:00", end_local: "17:00:00",
    }));
    expect(await readSchedulingFoundation()).toMatchObject({
      ok: false, error: "storage_unavailable",
    });
  });

  it("normalizes TIME columns in all scheduling tables, preserving overnight", async () => {
    for (const table of [
      "staff_availability_rules", "staff_availability_exceptions",
      "staff_preference_windows", "scheduling_coverage_requirements",
    ]) mocks.tables[table] = [{ id: id(1), start_local: "22:00:00",
      end_local: "02:00:00", overnight: true }];
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("read failed");
    for (const kind of ["availability_rule", "availability_exception",
      "preference_window", "coverage"] as const) {
      expect(result.records[kind][0]).toMatchObject({
        start_local: "22:00", end_local: "02:00", overnight: true,
      });
    }
  });

  it("never silently accepts malformed database time or unstable cursor rows", async () => {
    mocks.tables.staff_availability_rules = [
      { id: id(2), start_local: "09:00:20", end_local: "11:00:00" },
    ];
    expect(await readSchedulingFoundation()).toMatchObject({
      ok: false, error: "storage_unavailable",
    });
    mocks.tables.staff_availability_rules = [{ id: null, start_local: "09:00:00" }];
    expect(await readSchedulingFoundation()).toMatchObject({
      ok: false, error: "storage_unavailable",
    });
  });

  it("chunks compensation wage reads rather than silently truncating at PostgREST limits", async () => {
    mocks.compensation = Array.from({ length: 215 }, (_, i) => ({
      id: id(i + 301), employee_id: id(i + 1), cash_cost_state: "known_paid",
    }));
    mocks.wages = Array.from({ length: 215 }, (_, i) => ({
      id: id(i + 1), wage_period: "hour", wage_amount_cents: 1600,
      default_hourly_wage_cents: 1600,
    }));
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("read failed");
    expect(result.records.compensation).toHaveLength(215);
    expect((result.records.compensation as Array<{ cash_cost_state: string }>)
      .every((row) => row.cash_cost_state === "known_paid")).toBe(true);
    expect(mocks.requestedWages).toHaveBeenCalledTimes(3);
  });

  it("forwards a stable create request key to the atomic DB RPC", async () => {
    const requestKey = id(400);
    const data = { employee_id: id(1), day_of_week: 3,
      start_local: "07:00", end_local: "11:00", overnight: false,
      effective_from: "2026-10-14", source: "owner_direct", confirmation: "owner_confirmed" };
    mocks.rpc.mockResolvedValue({
      data: { id: id(450), revision: 1, replayed: false }, error: null,
    });
    const command = { kind: "availability_rule", action: "create", requestKey, data };
    expect(await executeFoundationCommand(command)).toEqual({ ok: true, id: id(450), revision: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith("scheduling_create_foundation", {
      p_business_id: "10000000-0000-4000-8000-000000000001",
      p_kind: "availability_rule", p_request_key: requestKey, p_record: data,
    });
    mocks.rpc.mockResolvedValue({
      data: { id: id(450), revision: 1, replayed: true }, error: null,
    });
    expect(await executeFoundationCommand(command)).toEqual({ ok: true, id: id(450), revision: 1 });
    mocks.rpc.mockResolvedValue({ data: { conflict: true }, error: null });
    expect(await executeFoundationCommand(command)).toEqual({
      ok: false, error: "conflict_or_missing",
    });
  });
});
