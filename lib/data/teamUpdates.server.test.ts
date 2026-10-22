import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertTeamUpdate } from "./teamUpdates.server";

const state = vi.hoisted(() => ({
  owner: true, created: true, rows: [] as Array<Record<string, unknown>>,
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({ from: (table: string) => {
    if (table === "memberships") {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: state.owner ? { user_id: "owner" } : null, error: null }) };
      return query;
    }
    if (table === "team_updates") return {
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => {
        state.rows.push(row); state.options.push(opts);
        return { select: () => ({ maybeSingle: async () => ({
          data: state.created ? { id: "created" } : null, error: null,
        }) }) };
      },
    };
    throw new Error("unexpected table");
  } }),
}));
const row = {
  business_id: "11111111-1111-4111-8111-111111111111",
  owner_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent_id: "alex" as const, domain: "menu_pricing" as const,
  kind: "price_review", severity: "attention" as const,
  subject_type: "menu_item", subject_id: null,
  facts: {}, text: "Review price", locale: "en", actions: [],
  dedupe_key: "item:review",
};
beforeEach(() => {
  state.owner = true; state.created = true;
  state.rows.length = 0; state.options.length = 0;
});
describe("team update data layer", () => {
  it("performs ON CONFLICT DO NOTHING and reports whether insertion occurred", async () => {
    expect(await insertTeamUpdate(row)).toBe(true);
    state.created = false;
    expect(await insertTeamUpdate(row)).toBe(false);
    expect(state.options).toEqual([
      { onConflict: "business_id,dedupe_key", ignoreDuplicates: true },
      { onConflict: "business_id,dedupe_key", ignoreDuplicates: true },
    ]);
    expect(state.rows).toHaveLength(2);
  });
  it("rejects a service-role write without matching owner membership", async () => {
    state.owner = false;
    await expect(insertTeamUpdate(row)).rejects.toThrow("owner membership");
    expect(state.rows).toHaveLength(0);
  });
});
