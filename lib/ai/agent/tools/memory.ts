import { z } from "zod";
import { POLICY_AGENTS, type RuleAgent } from "@/lib/ai/policies/contracts";
import type { AgentToolContext, AgentToolResult } from "./index";

/** Lasting café facts ("we close at 3pm on Sundays", "oat milk costs us $0.60 more").
 * The tool only DRAFTS a team rule; the owner approves it on a card. */
export const rememberCafeFactSchema = z.strictObject({
  fact: z.string().trim().min(5).max(300),
  applies_to: z.enum(POLICY_AGENTS),
});
export type CafeMemoryProposal = { ruleId: string; version: number; agentId: RuleAgent; fact: string; existing: boolean };
export type CafeMemoryPort = {
  proposeFact(input: { fact: string; agentId: RuleAgent }): Promise<CafeMemoryProposal | { missing: "memoryFull" | "memoryLimitPerTurn" }>;
};

export const memoryTools = { remember_cafe_fact: {
  agentId: "alex" as const,
  schema: rememberCafeFactSchema,
  description: "Only when the owner states a lasting fact or preference about the café worth remembering for future chats " +
    "(hours, suppliers, goals, how they like answers). One short fact, in the owner's words. Never for one-off numbers. " +
    "Creates an approval card; NEVER say it is saved until the owner approves. applies_to: supervisor for everyone, " +
    "alex sales/menu, olivia staff/hours, maya supplies, leo money.",
  execute: async (raw: unknown, ctx: AgentToolContext): Promise<AgentToolResult> => {
    const input = rememberCafeFactSchema.parse(raw);
    const base = { source: "memory_proposal", period: null, agentId: "alex" as const, draft: true, saved: false };
    if (!ctx.memory) return { ...base, missing: ["memoryUnavailable"] };
    const result = await ctx.memory.proposeFact({ fact: input.fact, agentId: input.applies_to });
    if ("missing" in result) return { ...base, missing: [result.missing] };
    return { ...base, missing: [], ruleId: result.ruleId, version: result.version,
      appliesTo: result.agentId, fact: result.fact, alreadyProposed: result.existing };
  },
} } as const;

const { $schema: _schema, ...parameters } = z.toJSONSchema(rememberCafeFactSchema, { target: "draft-07" });
void _schema;
/** Strict OpenAI function definition. Deliberately NOT part of agentToolDefinitions:
 * it is appended only when CHAT_MEMORY is on (see route), so the default tool list is unchanged. */
export const memoryToolDefinition = {
  type: "function" as const, name: "remember_cafe_fact",
  description: memoryTools.remember_cafe_fact.description, strict: true as const,
  parameters: { ...parameters, required: Object.keys(parameters.properties ?? {}) },
};
