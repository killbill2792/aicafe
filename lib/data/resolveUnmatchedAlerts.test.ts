import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveUnmatchedAlertsIfClear } from "./resolveUnmatchedAlerts.server";

vi.mock("@/lib/data/queryError", () => ({ logQueryError: vi.fn() }));

function fakeDb(pendingCount: number, options?: { readError?: boolean; updateError?: boolean }) {
  const reads: Array<[string, unknown]> = [];
  const writes: Array<[string, unknown]> = [];
  const select = {
    select: () => select,
    eq: (key: string, value: unknown) => { reads.push([key, value]); return select; },
    limit: async () => ({
      data: pendingCount ? [{id:"pending"}] : [],
      error: options?.readError ? {message:"review query failed"} : null,
    }),
  };
  const update = {
    update: (payload: unknown) => {writes.push(["patch", payload]); return update;},
    eq: (key: string, value: unknown) => {writes.push([key,value]); return update;},
    in: async (key:string, value: unknown) => {
      writes.push([key,value]);
      return {error: options?.updateError ? {message:"alert update failed"} : null};
    },
  };
  const client = {
    from: (table: string) => {
      if (table === "pos_catalog_matches") return select;
      if (table === "alerts") return update;
      throw new Error("unexpected table: " + table);
    },
  } as unknown as SupabaseClient;
  return {client,reads,writes};
}
const BUSINESS = "11111111-1111-4111-8111-111111111111";

describe("unmatched alert reconciliation", () => {
  it("does not clear alerts when other catalog review rows remain", async () => {
    const fake = fakeDb(1);
    expect(await resolveUnmatchedAlertsIfClear(fake.client,BUSINESS)).toBe(false);
    expect(fake.writes).toEqual([]);
    expect(fake.reads).toContainEqual(["business_id",BUSINESS]);
    expect(fake.reads).toContainEqual(["status","needs_review"]);
  });
  it("clears only this business's open unmatched alerts after last review", async () => {
    const fake = fakeDb(0);
    expect(await resolveUnmatchedAlertsIfClear(fake.client,BUSINESS)).toBe(true);
    expect(fake.writes).toContainEqual(["business_id",BUSINESS]);
    expect(fake.writes).toContainEqual(["kind","unmatched_sales_items"]);
    expect(fake.writes).toContainEqual(["status",["new","seen"]]);
    expect(fake.writes).toContainEqual(["patch",{status:"resolved"}]);
  });
  it("fails visibly on an unreadable review count instead of incorrectly clearing", async () => {
    const fake = fakeDb(0,{readError:true});
    await expect(resolveUnmatchedAlertsIfClear(fake.client,BUSINESS)).rejects.toThrow("catalog_review_unavailable");
    expect(fake.writes).toEqual([]);
  });
  it("reports failure when alert status cannot be updated", async () => {
    const fake = fakeDb(0,{updateError:true});
    await expect(resolveUnmatchedAlertsIfClear(fake.client,BUSINESS)).rejects.toThrow("alert_resolution_failed");
  });
});
