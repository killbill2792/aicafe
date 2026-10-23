import "server-only";
import type { TeamRulesService } from "@/lib/ai/policies/service";
import type { RuleAgent } from "@/lib/ai/policies/contracts";
import { formatCafeMemory, MEMORY_MAX_FACTS, normalizeFact } from "./memory";
import type { CafeMemoryPort } from "./tools/memory";

/** Loads approved facts for the model. Failure is non-fatal: the turn runs without
 * memory and we log a code (never the facts). */
export async function loadCafeMemory(rules: Pick<TeamRulesService, "listActiveRules">): Promise<string | null> {
  try { return formatCafeMemory(await rules.listActiveRules()); }
  catch { console.error("agent_memory_load_failed"); return null; }
}

/** Owner-scoped (RLS) draft creation for the memory tool. Idempotent: the same fact
 * returns the existing draft/active rule instead of creating a duplicate. */
export function cafeMemoryPort(rules: Pick<TeamRulesService, "listActiveRules" | "listRules" | "createDraft">,
  maxPerTurn = 1): CafeMemoryPort {
  let created = 0;
  return { async proposeFact({ fact, agentId }: { fact: string; agentId: RuleAgent }) {
    const key = normalizeFact(fact);
    const recent = (await rules.listRules(0)).items;
    const same = recent.find(rule => (rule.status === "draft" || rule.status === "active") && normalizeFact(rule.instruction) === key);
    if (same) return { ruleId: same.id, version: same.version, agentId: same.agentId, fact: same.instruction, existing: true };
    if (created >= maxPerTurn) return { missing: "memoryLimitPerTurn" as const };
    if ((await rules.listActiveRules()).length >= MEMORY_MAX_FACTS) return { missing: "memoryFull" as const };
    const draft = await rules.createDraft(agentId, fact.trim());
    created++;
    return { ruleId: draft.id, version: draft.version, agentId: draft.agentId, fact: draft.instruction, existing: false };
  } };
}
