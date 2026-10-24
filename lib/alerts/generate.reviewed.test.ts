import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasOpenAlert } from "./generate";

function fakeClient() {
  const rows = [
    { id:"resolved", status:"resolved", payload:{dedupeKey:"2026-10"} },
    { id:"dismissed", status:"dismissed", payload:{dedupeKey:"2026-11"} },
    { id:"open", status:"seen", payload:{dedupeKey:"2026-12"} },
  ];
  let statuses: string[] | null = null;
  const q = {
    select: vi.fn(() => q), eq: vi.fn(() => q),
    in: vi.fn((_field: string, list: string[]) => { statuses = list; return q; }),
    then: (onFulfilled: (value: { data: typeof rows }) => unknown) =>
      Promise.resolve({ data: rows.filter(row => !statuses || statuses.includes(row.status)) }).then(onFulfilled),
  };
  const from = vi.fn(() => { statuses = null; return q; });
  return { db: { from } as unknown as SupabaseClient, from, q };
}

describe("generated-alert disposition dedupe", () => {
  it("honors Done and Not an issue for the same dedupe key", async () => {
    const { db } = fakeClient();
    expect(await hasOpenAlert(db, "cafe", "voids", "2026-10", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "voids", "2026-11", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "voids", "2026-12", true)).toBe(true);
    expect(await hasOpenAlert(db, "cafe", "voids", "2027-01", true)).toBe(false);
  });
  it("preserves open-only matching for CSV import dedupe", async () => {
    const { db, q } = fakeClient();
    expect(await hasOpenAlert(db, "cafe", "unmatched_sales_items", "2026-10")).toBe(false);
    expect(await hasOpenAlert(db, "cafe", "unmatched_sales_items", "2026-12")).toBe(true);
    expect(q.in).toHaveBeenCalledWith("status", ["new", "seen"]);
  });
});
