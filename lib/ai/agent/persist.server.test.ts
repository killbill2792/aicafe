import { describe, expect, it } from "vitest";
import { agentReplyPayload, persistedAgentStatus } from "./persist.server";
import type { AgentTurn } from "./loop.server";

function turn(text: string): AgentTurn {
  return {
    text, endReason: "complete", status: { status: "complete", missing: [] },
    results: [{ source: "menu_items", period: null, missing: [], items: [] }],
    unverified: [{ text: "$99.99", start: 1198, end: 1204, kind: "money" }],
    usage: { modelCalls: 2, toolCalls: 1, inputTokens: 70, cachedTokens: 20,
      outputTokens: 90, latencyMs: 1200 },
  };
}
describe("database-safe agent persistence payload", () => {
  it("maps completed and partial results to the allowed database statuses", () => {
    const allowed = ["verified", "estimated", "partial", "unavailable",
      "insufficient_evidence", "requires_owner_input"];
    expect(persistedAgentStatus(turn("ready"))).toBe("verified");
    expect(persistedAgentStatus({ ...turn("partial"), status: { status:"partial",missing:["sales"] }})).toBe("partial");
    expect(persistedAgentStatus({ ...turn("none"), results:[] })).toBe("unavailable");
    expect(persistedAgentStatus({ ...turn("error"), results:[{
      source:"get_sales",period:null,missing:["tool_unavailable"],error:"tool_unavailable"
    }] })).toBe("unavailable");
    for (const status of [persistedAgentStatus(turn("ok")),
      persistedAgentStatus({ ...turn("unknown"),results:[] })])
      expect(allowed).toContain(status);
  });
  it("persists all text over 1200 characters and maps cross-block annotations", () => {
    const content = "a".repeat(1198) + "$99.99" + "z".repeat(1600);
    const payload = agentReplyPayload(turn(content));
    expect(payload.reply.blocks.length).toBe(3);
    expect(payload.reply.blocks.map(block => "text" in block ? block.text : "").join("")).toBe(content);
    expect(payload.metadata.unverified).toEqual([
      {text:"$9",start:1198,end:1200,kind:"money",blockIndex:0},
      {text:"9.99",start:0,end:4,kind:"money",blockIndex:1},
    ]);
    expect(payload.metadata.usage.cachedTokens).toBe(20);
  });
  it("rejects answers beyond the 30-block storage capacity instead of truncating silently", () => {
    expect(() => agentReplyPayload(turn("x".repeat(36001)))).toThrow("agent_reply_too_long");
  });
});
