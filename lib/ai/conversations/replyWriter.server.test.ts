import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundedSupervisorReply, ConversationMessage } from "./contracts";

const data = vi.hoisted(() => ({
  stored: new Map<string, Record<string, unknown>>(),
  inserts: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== "ai_messages") throw new Error("Unexpected table");
      return {
        select: () => {
          const filters: Record<string, string> = {};
          return {
            eq(column: string, value: string) { filters[column] = value; return this; },
            async maybeSingle() {
              const row = [...data.stored.values()].find((candidate) =>
                Object.entries(filters).every(([key, value]) => candidate[key] === value));
              return { data: row ?? null, error: null };
            },
          };
        },
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            async single() {
              data.inserts++;
              const result = { ...row, created_at: "2026-10-10T06:00:00Z" };
              data.stored.set(String(row.id), result);
              return { data: result, error: null };
            },
          }),
        }),
      };
    },
  }),
}));

import { getExistingSupervisorReply, persistGroundedSupervisorReply } from "./replyWriter.server";

const scope = { businessId: "cafe-one", ownerUserId: "owner-one" };
const msg: ConversationMessage = {
  id: "9be839c5-8a6a-4fd0-a00c-8903a2d5da77",
  threadId: "thread-one", role: "owner", contentType: "text",
  text: "How are sales?", blocks: null, grounding: null,
  clientMessageId: "key-one", createdAt: "2026-10-10T06:00:00Z",
};
const source = { source: "cafe_state" as const, identifier: "profitability:2026-10-10", asOf: "2026-10-10" };
const answer: GroundedSupervisorReply = {
  intent: "profitability", status: "verified", evidence: [source],
  blocks: [{ type: "metric", label: "Profit", valueCents: 12300, source }],
};

describe("Phase 4 audited privileged reply writer", () => {
  beforeEach(() => { data.stored.clear(); data.inserts = 0; });

  it("links reply to the owner and café with stable one-message idempotency", async () => {
    const first = await persistGroundedSupervisorReply(scope, msg, answer);
    const replay = await persistGroundedSupervisorReply(scope, msg, answer);
    expect(replay.id).toBe(first.id);
    expect(data.inserts).toBe(1);
    const db = data.stored.get(first.id);
    expect(db).toMatchObject({
      business_id: "cafe-one", owner_user_id: "owner-one",
      thread_id: "thread-one", role: "supervisor",
      author_user_id: null, content_type: "blocks",
    });
    expect(db?.grounding).toMatchObject({
      ownerMessageId: msg.id, status: "verified",
      responder: "deterministic-structured-cafe-tools-v1",
    });
    expect(await getExistingSupervisorReply(scope, msg)).toEqual(first);
  });

  it("never inserts a Supervisor reply on missing evidence or forged client roles", async () => {
    await expect(persistGroundedSupervisorReply(scope, msg, {
      ...answer, evidence: [],
    })).rejects.toThrow();
    await expect(persistGroundedSupervisorReply(scope, {
      ...msg, role: "supervisor", contentType: "blocks",
    }, answer)).rejects.toThrow();
    expect(data.inserts).toBe(0);
  });

  it("won't read a supervisor reply under another owner or café scope", async () => {
    await persistGroundedSupervisorReply(scope, msg, answer);
    expect(await getExistingSupervisorReply({ ...scope, businessId: "other" }, msg)).toBeNull();
    expect(await getExistingSupervisorReply({ ...scope, ownerUserId: "other" }, msg)).toBeNull();
  });
});
