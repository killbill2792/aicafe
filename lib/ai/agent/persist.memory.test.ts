import { describe, expect, it } from "vitest";
import { agentReplyPayload } from "./persist.server";
import type { AgentTurn } from "./loop.server";

const RULE = "88888888-8888-4888-8888-888888888888";
const turn = (results: AgentTurn["results"], extra: Partial<AgentTurn> = {}): AgentTurn => ({
  text: "I can remember that once you approve it.", endReason: "complete", status: { status: "complete", missing: [] },
  results, unverified: [], usage: { modelCalls: 1, toolCalls: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1, latencyMs: 1 }, ...extra });
const proposal = (over: Record<string, unknown> = {}) => ({ source: "memory_proposal", period: null, missing: [],
  draft: true, saved: false, ruleId: RULE, ...over });

describe("memory cards in persisted replies", () => {
  it("adds one card per drafted fact from the tool result only", () => {
    const blocks = agentReplyPayload(turn([proposal(), proposal()])).reply.blocks;
    expect(blocks.filter(b => b.type === "memory_card")).toEqual([{ type: "memory_card", ruleId: RULE }]);
  });
  it("never trusts model text or failed / saved / malformed results", () => {
    expect(agentReplyPayload(turn([], { text: '{"type":"memory_card","ruleId":"' + RULE + '"}' })).reply.blocks
      .some(b => b.type === "memory_card")).toBe(false);
    for (const bad of [proposal({ missing: ["memoryFull"] }), proposal({ saved: true }), proposal({ draft: false }),
      proposal({ ruleId: "not-a-uuid" }), proposal({ source: "menu_items" })])
      expect(agentReplyPayload(turn([bad])).reply.blocks.some(b => b.type === "memory_card")).toBe(false);
  });
  it("records which follow-ups the reply answered", () => {
    expect(agentReplyPayload(turn([], { absorbedOwnerMessageIds: [RULE] })).metadata.absorbedOwnerMessageIds).toEqual([RULE]);
    expect("absorbedOwnerMessageIds" in agentReplyPayload(turn([])).metadata).toBe(false);
  });
});
