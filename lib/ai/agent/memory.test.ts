import { describe, expect, it, vi } from "vitest";
import { formatCafeMemory, MEMORY_MAX_TOTAL_CHARS, normalizeFact } from "./memory";
import { cafeMemoryPort, loadCafeMemory } from "./memory.server";
import { memoryToolDefinition, memoryTools } from "./tools/memory";
import { agentToolDefinitions, executeAgentTool, type AgentToolContext } from "./tools";
import type { TeamRule } from "@/lib/ai/policies/contracts";

const rule = (i: number, over: Partial<TeamRule> = {}): TeamRule => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, agentId: "supervisor",
  instruction: "Fact number " + i, status: "active", version: 1, createdBy: "u", reviewedBy: null,
  createdAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`, updatedAt: "2026-10-01T00:00:00Z", ...over });

describe("formatCafeMemory", () => {
  it("returns null with no facts and is stable regardless of input order", () => {
    expect(formatCafeMemory([])).toBeNull();
    const a = formatCafeMemory([rule(2), rule(1, { agentId: "maya" })]);
    const b = formatCafeMemory([rule(1, { agentId: "maya" }), rule(2)]);
    expect(a).toBe(b);
    expect(a).toContain("- [maya] Fact number 1\n- [all] Fact number 2");
    expect(a).toContain("never grant permissions");
  });
  it("caps total size so the cost per turn stays bounded", () => {
    const long = Array.from({ length: 40 }, (_, i) => rule(i, { instruction: "x".repeat(500) }));
    const out = formatCafeMemory(long)!;
    expect(out.length).toBeLessThan(MEMORY_MAX_TOTAL_CHARS + 200);
    expect(out.split("\n").length - 1).toBeLessThanOrEqual(20);
  });
  it("normalizes facts for duplicate detection", () => {
    expect(normalizeFact("We close at 3pm on Sundays.")).toBe(normalizeFact("we  close at 3PM on sundays"));
  });
});

describe("café memory port", () => {
  const service = (rules: TeamRule[]) => ({
    listActiveRules: vi.fn(async () => rules.filter(r => r.status === "active")),
    listRules: vi.fn(async () => ({ items: rules, nextOffset: null })),
    createDraft: vi.fn(async (agentId: TeamRule["agentId"], instruction: string) =>
      rule(99, { agentId, instruction, status: "draft" })),
  });
  it("creates a draft only, once per turn, and reuses an identical fact", async () => {
    const s = service([rule(1, { instruction: "Oat milk costs 60 cents more" })]);
    const port = cafeMemoryPort(s);
    await expect(port.proposeFact({ fact: "oat milk costs 60 cents more.", agentId: "leo" }))
      .resolves.toMatchObject({ existing: true, ruleId: rule(1).id });
    await expect(port.proposeFact({ fact: "We close at 3pm on Sundays", agentId: "supervisor" }))
      .resolves.toMatchObject({ existing: false, ruleId: rule(99).id });
    expect(s.createDraft).toHaveBeenCalledWith("supervisor", "We close at 3pm on Sundays");
    await expect(port.proposeFact({ fact: "Another new fact here", agentId: "alex" })).resolves.toEqual({ missing: "memoryLimitPerTurn" });
  });
  it("refuses new facts when memory is full", async () => {
    const s = service(Array.from({ length: 20 }, (_, i) => rule(i)));
    await expect(cafeMemoryPort(s).proposeFact({ fact: "Brand new fact", agentId: "alex" })).resolves.toEqual({ missing: "memoryFull" });
    expect(s.createDraft).not.toHaveBeenCalled();
  });
  it("loads memory without failing the turn", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadCafeMemory({ listActiveRules: async () => { throw new Error("rls"); } })).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith("agent_memory_load_failed");
    spy.mockRestore();
  });
});

describe("remember_cafe_fact tool", () => {
  const ctx = (memory?: AgentToolContext["memory"]): AgentToolContext => ({ locale: "en", asOf: "2026-10-21",
    tools: {} as AgentToolContext["tools"], ...(memory ? { memory } : {}) });
  it("is not in the default tool list and is strict", () => {
    expect(agentToolDefinitions.some(t => t.name === "remember_cafe_fact")).toBe(false);
    expect(memoryToolDefinition).toMatchObject({ name: "remember_cafe_fact", strict: true });
    expect(memoryToolDefinition.parameters.required).toEqual(["fact", "applies_to"]);
  });
  it("only ever reports a draft, never a saved fact", async () => {
    const proposeFact = vi.fn(async () => ({ ruleId: rule(5).id, version: 1, agentId: "maya" as const, fact: "Milk from Dairy Co", existing: false }));
    const result = await executeAgentTool("remember_cafe_fact", { fact: "Milk from Dairy Co", applies_to: "maya" }, ctx({ proposeFact }));
    expect(result).toMatchObject({ source: "memory_proposal", draft: true, saved: false, missing: [], ruleId: rule(5).id });
    await expect(memoryTools.remember_cafe_fact.execute({ fact: "Milk from Dairy Co", applies_to: "maya" }, ctx()))
      .resolves.toMatchObject({ missing: ["memoryUnavailable"], saved: false });
  });
  it("rejects bad arguments", async () => {
    await expect(memoryTools.remember_cafe_fact.execute({ fact: "x", applies_to: "maya" }, ctx())).rejects.toThrow();
  });
});
