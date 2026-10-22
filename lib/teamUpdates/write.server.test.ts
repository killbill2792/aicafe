import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeTeamUpdate } from "./write.server";

const state = vi.hoisted(() => ({
  inserted: true,
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/data/teamUpdates.server", () => ({
  insertTeamUpdate: async (row: Record<string, unknown>) => {
    state.rows.push(row);
    return state.inserted;
  },
}));
const input = {
  businessId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  domain: "menu_pricing" as const,
  kind: "review",
  severity: "attention" as const,
  subjectType: "menu_item",
  text: "Review price",
  locale: "en" as const,
  actions: [{ kind: "open" as const }],
  dedupeKey: "item:review",
};
beforeEach(() => { state.inserted = true; state.rows.length = 0; });

describe("team updates writer", () => {
  it("propagates created vs deduplicated from persistence", async () => {
    expect(await writeTeamUpdate(input)).toEqual({ created: true });
    state.inserted = false;
    expect(await writeTeamUpdate(input)).toEqual({ created: false });
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({
      business_id: input.businessId,
      owner_user_id: input.ownerUserId,
      agent_id: "alex",
      dedupe_key: input.dedupeKey,
    });
  });
  it.each([["menu_pricing","alex"],["labor","olivia"],["supplies","maya"],["money","leo"]] as const)
  ("derives the existing persona for %s", async (domain, agent) => {
    await writeTeamUpdate({ ...input, domain });
    expect(state.rows[0].agent_id).toBe(agent);
  });
  it("rejects invalid action kind without touching persistence", async () => {
    await expect(writeTeamUpdate({ ...input, actions: [{ kind: "unsafe" as "open" }] })).rejects.toThrow();
    expect(state.rows).toHaveLength(0);
  });
  it("enforces text length before persistence", async () => {
    await expect(writeTeamUpdate({ ...input, text: "x".repeat(601) })).rejects.toThrow();
    expect(state.rows).toHaveLength(0);
  });
});
