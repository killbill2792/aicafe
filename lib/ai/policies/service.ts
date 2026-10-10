import type { ConversationScope } from "@/lib/ai/conversations/contracts";
import type { RuleAgent, RuleDecision, RuleEvent, RulesPage, RuleStatus, TeamRule } from "./contracts";

export class RuleNotFound extends Error {}
export class RuleConflict extends Error {}
export class RuleTransitionDenied extends Error {}

export type PolicyScope = ConversationScope;

export interface TeamRulesRepository {
  listRules(scope: PolicyScope, offset: number): Promise<RulesPage<TeamRule>>;
  listEvents(scope: PolicyScope, offset: number): Promise<RulesPage<RuleEvent>>;
  listActiveRules(scope: PolicyScope): Promise<TeamRule[]>;
  findRule(scope: PolicyScope, id: string): Promise<TeamRule | null>;
  createDraft(scope: PolicyScope, agentId: RuleAgent, instruction: string): Promise<TeamRule>;
  compareAndSetStatus(scope: PolicyScope, id: string, expectedVersion: number, status: RuleStatus):
    Promise<TeamRule | null>;
}

export function targetRuleStatus(current: RuleStatus, decision: RuleDecision): RuleStatus {
  if (current === "draft" && decision === "approve") return "active";
  if (current === "draft" && decision === "reject") return "rejected";
  if (current === "active" && decision === "pause") return "paused";
  if (current === "paused" && decision === "resume") return "active";
  throw new RuleTransitionDenied("Invalid rule approval transition");
}

/** Auth-bound owner policy service. No method applies business changes. */
export class TeamRulesService {
  constructor(private repository: TeamRulesRepository, private scope: PolicyScope) {
    if (!scope.businessId || !scope.ownerUserId) throw new Error("Missing authorized owner scope");
  }

  listRules(offset = 0) {
    return this.repository.listRules(this.scope, offset);
  }

  listEvents(offset = 0) {
    return this.repository.listEvents(this.scope, offset);
  }

  listActiveRules() {
    return this.repository.listActiveRules(this.scope);
  }

  createDraft(agentId: RuleAgent, instruction: string) {
    return this.repository.createDraft(this.scope, agentId, instruction);
  }

  async reviewRule(id: string, expectedVersion: number, decision: RuleDecision): Promise<TeamRule> {
    const existing = await this.repository.findRule(this.scope, id);
    if (!existing) throw new RuleNotFound("Rule not found");
    if (existing.version !== expectedVersion) throw new RuleConflict("Rule version is no longer current");
    const status = targetRuleStatus(existing.status, decision);
    const changed = await this.repository.compareAndSetStatus(this.scope, id, expectedVersion, status);
    if (!changed) throw new RuleConflict("Rule changed during review");
    if (changed.status !== status || changed.version !== expectedVersion + 1) {
      throw new RuleConflict("Rule transition was not recorded correctly");
    }
    return changed;
  }
}
