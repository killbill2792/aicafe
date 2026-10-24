import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { generateAlerts, hasOpenAlert } from "./generate";
import { blocksGeneratedAlert, withOwnerDisposition } from "./reconcile";

function fakeClient() {
  const rows = [
    { id: "owner-done", status: "resolved", payload: { dedupeKey: "rent", dispositionSource: "owner" } },
    { id: "auto-corrected", status: "resolved", payload: { dedupeKey: "corrected-rent" } },
    { id: "historical-auto", status: "resolved", payload: { dedupeKey: "old-correction" } },
    { id: "owner-dismissed", status: "dismissed", payload: { dedupeKey: "not-an-issue" } },
    { id: "still-open", status: "seen", payload: { dedupeKey: "open" } },
  ];
  let statuses: string[] | null = null;
  const q = {
    select: vi.fn(() => q), eq: vi.fn(() => q),
    in: vi.fn((_field: string, list: string[]) => { statuses = list; return q; }),
    then: (onFulfilled: (value: { data: typeof rows; error: null }) => unknown) =>
      Promise.resolve({
        data: rows.filter(row => !statuses || statuses.includes(row.status)),
        error: null,
      }).then(onFulfilled),
  };
  const from = vi.fn(() => { statuses = null; return q; });
  return { db: { from } as unknown as SupabaseClient, from, q };
}

describe("generated alert lifecycle and owner intent", () => {
  it("never queries or writes the shared demo when generating alerts", async () => {
    const from = vi.fn(() => { throw new Error("Demo should never write or even query generators"); });
    const result = await generateAlerts({ from } as unknown as SupabaseClient, DEMO_BUSINESS_ID);
    expect(result).toEqual({ created: 0 });
    expect(from).not.toHaveBeenCalled();
  });

  it("preserves existing incident payload fields while recording owner intent", () => {
    expect(withOwnerDisposition({ dedupeKey: "2026-10-rent", categoryCode: "rent" }))
      .toEqual({ dedupeKey: "2026-10-rent", categoryCode: "rent", dispositionSource: "owner" });
  });

  it("owner Done and Not an issue suppress the same occurrence, but auto resolution does not", async () => {
    const { db } = fakeClient();
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "rent", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "not-an-issue", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "open", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "corrected-rent", true)).toBe(false);
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "old-correction", true)).toBe(false);
    expect(await hasOpenAlert(db, "cafe", "missing_bill", "new-incident", true)).toBe(false);
    expect(blocksGeneratedAlert("resolved", { dispositionSource: "owner" })).toBe(true);
    expect(blocksGeneratedAlert("resolved", { dispositionSource: "system" })).toBe(false);
  });

  it("CSV import deduplication remains open-only even for owner-resolved and dismissed rows", async () => {
    const { db, q } = fakeClient();
    expect(await hasOpenAlert(db, "cafe", "unmatched_sales_items", "rent")).toBe(false);
    expect(await hasOpenAlert(db, "cafe", "unmatched_sales_items", "not-an-issue")).toBe(false);
    expect(await hasOpenAlert(db, "cafe", "unmatched_sales_items", "open")).toBe(true);
    expect(q.in).toHaveBeenCalledWith("status", ["new", "seen"]);
  });
});
