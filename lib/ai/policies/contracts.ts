import { z } from "zod";

export const POLICY_AGENTS = ["supervisor", "alex", "olivia", "maya", "leo"] as const;
export const RULE_STATUSES = ["draft", "active", "paused", "rejected"] as const;
export const ruleIdInput = z.uuid();

export const createRuleInput = z.strictObject({
  agentId: z.enum(POLICY_AGENTS),
  instruction: z.string().trim().min(5).max(1000),
});

export const reviewRuleInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "pause", "resume"]),
});

export const rulePageInput = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

export type RuleStatus = (typeof RULE_STATUSES)[number];
export type RuleAgent = (typeof POLICY_AGENTS)[number];
export type RuleDecision = z.infer<typeof reviewRuleInput>["decision"];

export type TeamRule = {
  id: string;
  agentId: RuleAgent;
  instruction: string;
  status: RuleStatus;
  version: number;
  createdBy: string;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RuleEvent = {
  id: number;
  ruleId: string;
  actorUserId: string;
  agentId: RuleAgent;
  instruction: string;
  previousStatus: RuleStatus | null;
  newStatus: RuleStatus;
  version: number;
  createdAt: string;
};

export type RulesPage<T> = { items: T[]; nextOffset: number | null };

export const RULE_PAGE_SIZE = 40;

/**
 * A natural-language instruction is human guidance only. It MUST NOT become
 * executable code, a permissions grant, a pricing formula, or a raw LLM tool.
 * Only explicitly allow-listed read tools are authorized for the Supervisor.
 */
export type SupervisorCapability =
  | "read_cafe_state" | "read_pricing" | "read_team_tasks"
  | "change_price" | "change_staff_schedule" | "contact_supplier"
  | "write_payroll" | "update_pos" | "unknown";
export function evaluateSupervisorPermission(action: SupervisorCapability): {
  permitted: boolean; needsOwnerApproval: boolean; reason: string;
} {
  if (action === "read_cafe_state" || action === "read_pricing" || action === "read_team_tasks") {
    return { permitted: true, needsOwnerApproval: false, reason: "trusted_read_only" };
  }
  // Existing owner-approved product paths remain canonical. An approved AI
  // team rule is not permission to execute a side effect or create an inbox.
  return { permitted: false, needsOwnerApproval: true, reason: "business_write_not_authorized" };
}
