import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn(async () => "en") }));

const fixture = vi.hoisted(() => ({
  businessId: "owner-cafe",
  row: { id: "alert-id", business_id: "owner-cafe", status: "new", payload: { dedupeKey: "2026-10-rent", categoryCode: "rent" } as Record<string, unknown> },
  writes: [] as Array<Record<string, unknown>>,
  fromCalls: 0,
}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({
  getActiveBusinessId: vi.fn(async () => fixture.businessId),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from: (table: string) => {
      fixture.fromCalls++;
      if (table !== "alerts") throw new Error("Unexpected table " + table);
      const filters: Record<string, string> = {};
      let statuses: string[] | null = null;
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: (key: string, value: string) => { filters[key] = value; return q; },
        in: (_key: string, values: string[]) => { statuses = values; return q; },
        update: (value: Record<string, unknown>) => { patch = value; return q; },
        maybeSingle: async () => {
          const row = fixture.row;
          const allowed = filters.id === row.id && filters.business_id === row.business_id &&
            (!statuses || statuses.includes(row.status)) &&
            (!filters.status || filters.status === row.status);
          if (!allowed) return { data: null, error: null };
          if (patch) {
            fixture.writes.push(patch);
            row.status = patch.status as string;
            if (patch.payload) row.payload = patch.payload as Record<string, unknown>;
            return { data: { id: row.id }, error: null };
          }
          return { data: { status: row.status, payload: row.payload }, error: null };
        },
      };
      return q;
    },
  })),
}));

import { setAlertStatus } from "./alerts";

beforeEach(() => {
  fixture.businessId = "owner-cafe";
  fixture.row = {
    id: "alert-id", business_id: "owner-cafe", status: "new",
    payload: { dedupeKey: "2026-10-rent", categoryCode: "rent" },
  };
  fixture.writes.length = 0;
  fixture.fromCalls = 0;
});

describe("alert status action", () => {
  it.each(["seen", "resolved", "dismissed"] as const)("never edits the shared demo when status=%s", async status => {
    fixture.businessId = DEMO_BUSINESS_ID;
    expect(await setAlertStatus("alert-id", status)).toEqual({ ok: false });
    expect(fixture.fromCalls).toBe(0);
    expect(fixture.writes).toHaveLength(0);
  });

  it("persists the explicit owner Done provenance and preserves the incident identity", async () => {
    expect(await setAlertStatus("alert-id", "resolved")).toEqual({ ok: true });
    expect(fixture.writes).toEqual([{
      status: "resolved",
      payload: { dedupeKey: "2026-10-rent", categoryCode: "rent", dispositionSource: "owner" },
    }]);
  });

  it("persists owner Not an issue, without losing existing payload details", async () => {
    expect(await setAlertStatus("alert-id", "dismissed")).toEqual({ ok: true });
    expect(fixture.row).toMatchObject({
      status: "dismissed",
      payload: { categoryCode: "rent", dedupeKey: "2026-10-rent", dispositionSource: "owner" },
    });
  });

  it("marking seen does not save a false owner resolution marker", async () => {
    expect(await setAlertStatus("alert-id", "seen")).toEqual({ ok: true });
    expect(fixture.writes).toEqual([{ status: "seen" }]);
  });

  it("cannot change an alert from another café or an already auto-resolved row", async () => {
    fixture.row.business_id = "another-cafe";
    expect(await setAlertStatus("alert-id", "resolved")).toEqual({ ok: false });
    fixture.row.business_id = "owner-cafe";
    fixture.row.status = "resolved";
    expect(await setAlertStatus("alert-id", "dismissed")).toEqual({ ok: false });
    expect(fixture.writes).toHaveLength(0);
  });
});
