import { describe, expect, it } from "vitest";
import { agentReplyPayload, persistedAgentStatus, splitAgentText } from "./persist.server";
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
  it("maps a greeting to verified, failed tools to unavailable and missing data to partial", () => {
    const greeting = { ...turn("Hi there"), results: [], usage: { ...turn("").usage, toolCalls: 0 } };
    const failed = { ...turn("Unavailable"), results: [{
      source:"get_sales",period:null,missing:["tool_unavailable"],error:"tool_unavailable",
    }] };
    const partial = { ...turn("Not all data"), status: { status:"partial" as const,missing:["sales"] },
      results:[{source:"daily_rollups",period:null,missing:["sales"]}] };
    expect(persistedAgentStatus(greeting)).toBe("verified");
    expect(persistedAgentStatus(failed)).toBe("unavailable");
    expect(persistedAgentStatus(partial)).toBe("partial");
    expect(persistedAgentStatus({ ...greeting, endReason:"provider_error" })).toBe("unavailable");
  });
  it("splits on paragraphs, newlines, and whitespace without bisecting a word or number", () => {
    const number = "$99.99";
    const content = "First paragraph.\n\n" + "long ".repeat(237) + "Total " + number +
      " more words ".repeat(120);
    const start = content.indexOf(number);
    const payload = agentReplyPayload({ ...turn(content),
      unverified:[{text:number,start,end:start+number.length,kind:"money"}] });
    const blocks = payload.reply.blocks.map(b => "text" in b ? b.text : "");
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every(b => b.length <= 1200)).toBe(true);
    expect(blocks.join("")).toBe(content);
    const boundaries = blocks.slice(0,-1).map((_,i) => blocks.slice(0,i+1).join("").length);
    for (const at of boundaries) {
      expect(at > start && at < start+number.length).toBe(false);
      expect(/\s/u.test(content[at-1])).toBe(true);
    }
    expect(payload.metadata.unverified).toEqual([{
      text:number, start:start - blocks.slice(0,blocks.findIndex((b, i) => {
        const begin = blocks.slice(0,i).join("").length;
        return begin <= start && start < begin + b.length;
      })).join("").length,
      end: start + number.length - blocks.slice(0,blocks.findIndex((b,i) => {
        const begin = blocks.slice(0,i).join("").length;
        return begin <= start && start < begin + b.length;
      })).join("").length,
      kind:"money",
      blockIndex: blocks.findIndex((b,i) => {
        const begin=blocks.slice(0,i).join("").length;
        return begin<=start && start<begin+b.length;
      }),
    }]);
    expect(payload.metadata.usage.cachedTokens).toBe(20);
  });
  it("keeps a currency token intact even when its suffix would cross 1200", () => {
    const content = "x".repeat(1193) + " 123,45 €" + " rest ".repeat(90);
    const blocks = splitAgentText(content);
    expect(blocks.join("")).toBe(content);
    const firstBoundary = blocks[0].length;
    expect(firstBoundary <= 1194).toBe(true);
    expect(blocks.some(b => b.includes("123,45 €"))).toBe(true);
  });
  it("never cuts inside a verified number after an oversized unbroken word", () => {
    const content = "x".repeat(1198) + "123.45" + " more words ".repeat(25);
    const blocks = splitAgentText(content);
    expect(blocks.join("")).toBe(content);
    expect(blocks[0].length).toBe(1198);
    expect(blocks[1].startsWith("123.45")).toBe(true);
  });
  it("rejects answers beyond the 30-block storage capacity instead of truncating silently", () => {
    expect(() => agentReplyPayload(turn("x".repeat(36001)))).toThrow("agent_reply_too_long");
  });
});
