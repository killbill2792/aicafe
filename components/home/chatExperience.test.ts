import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import type { AgentJob, AgentJobStep } from "@/lib/ai/agent/jobState";
import { answeredOwnerMessageIds, chatExperienceCopy, failureLine, inFlightOwnerMessageIds,
  progressLines, readSseFrames } from "./chatExperience";

const keys = (value: unknown, prefix = ""): string[] => value && typeof value === "object"
  ? Object.entries(value).flatMap(([k, v]) => keys(v, prefix + k + ".")) : [prefix];
const copy = chatExperienceCopy("en");

describe("chat experience helpers", () => {
  it("has the same copy keys in English, Spanish and Arabic", () => {
    for (const ns of ["ChatExperience", "MemoryCard"] as const) {
      expect(keys(es[ns])).toEqual(keys(en[ns]));
      expect(keys(ar[ns])).toEqual(keys(en[ns]));
    }
    for (const locale of ["en", "es", "ar"] as const)
      for (const line of keys(chatExperienceCopy(locale))) expect(line.length).toBeGreaterThan(0);
  });
  it("has a one-line failure for every code and a generic fallback", () => {
    for (const code of ["timeout", "agent_busy", "attempts_exhausted", "reply_storage_failed"])
      expect(failureLine(code, copy)).toBe((copy.failures as Record<string, string>)[code]);
    expect(failureLine("something_new", copy)).toBe(copy.failures.agent_turn_failed);
    expect(failureLine(null, copy)).toBe(copy.failures.agent_turn_failed);
    for (const line of Object.values(copy.failures)) expect(line).not.toContain("\n");
  });
  it("turns steps into short progress lines without repeats", () => {
    const lines = progressLines([{ tool: "get_sales", agent: "alex" }, { tool: "get_sales", agent: "alex" },
      { tool: "unknown_tool", agent: "olivia" }, { tool: "unknown_tool", agent: "nobody" }] as AgentJobStep[], copy);
    expect(lines).toEqual([copy.tools.get_sales, copy.agents.olivia, copy.agents.supervisor]);
    const many = Array.from({ length: 10 }, (_, i) => ({ tool: i % 2 ? "get_sales" : "get_profit", agent: "alex" as const }));
    expect(progressLines(many, copy)).toHaveLength(6);
  });
  it("knows which owner messages are answered or still being worked on", () => {
    const reply = { role: "supervisor", grounding: { ownerMessageId: "a", agentMetadata: { absorbedOwnerMessageIds: ["b", 3] } } };
    expect([...answeredOwnerMessageIds([reply, { role: "owner", grounding: null }] as unknown as ConversationMessage[])]).toEqual(["a", "b"]);
    const job = { status: "running", ownerMessageId: "c", inbox: ["d"], consumed: ["e"] } as unknown as AgentJob;
    expect([...inFlightOwnerMessageIds(job, ["x"])].sort()).toEqual(["c", "d", "e", "x"]);
    expect([...inFlightOwnerMessageIds({ ...job, status: "failed" } as AgentJob)]).toEqual([]);
    expect([...inFlightOwnerMessageIds(null)]).toEqual([]);
  });
  it("reads complete SSE frames, keeps the partial rest and skips junk", () => {
    const { frames, rest } = readSseFrames('event: ack\ndata: {"jobId":"j"}\n\nevent: bad\ndata: {oops\n\nevent: delta\r\ndata: {"text":"Hi"}\r\n\r\nevent: done\ndata: {"rep');
    expect(frames).toEqual([{ type: "ack", data: { jobId: "j" } }, { type: "delta", data: { text: "Hi" } }]);
    expect(rest).toBe('event: done\ndata: {"rep');
    expect(readSseFrames(rest + 'ly":1}\n\n').frames).toEqual([{ type: "done", data: { reply: 1 } }]);
  });
});
