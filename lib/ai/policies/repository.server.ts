import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyScope, TeamRulesRepository } from "./service";
import type { RuleAgent, RuleEvent, RuleStatus, RulesPage, TeamRule } from "./contracts";
import { RULE_PAGE_SIZE } from "./contracts";

const COLUMNS = "id, agent_id, instruction, status, version, created_by, reviewed_by, created_at, updated_at";
type RuleRow = {
  id: string; agent_id: RuleAgent; instruction: string; status: RuleStatus; version: number;
  created_by: string; reviewed_by: string | null; created_at: string; updated_at: string;
};
type EventRow = {
  id: number; rule_id: string; actor_user_id: string; agent_id: RuleAgent; instruction_snapshot: string;
  previous_status: RuleStatus | null; new_status: RuleStatus; version: number; created_at: string;
};

function toRule(row: RuleRow): TeamRule {
  return { id: row.id, agentId: row.agent_id, instruction: row.instruction,
    status: row.status, version: row.version, createdBy: row.created_by,
    reviewedBy: row.reviewed_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toEvent(row: EventRow): RuleEvent {
  return { id: row.id, ruleId: row.rule_id, actorUserId: row.actor_user_id, agentId: row.agent_id,
    instruction: row.instruction_snapshot, previousStatus: row.previous_status,
    newStatus: row.new_status, version: row.version, createdAt: row.created_at };
}

/** Authenticated RLS Supabase client, never a service-role client. */
export class SupabaseTeamRulesRepository implements TeamRulesRepository {
  constructor(private client: SupabaseClient) {}

  async listRules(scope: PolicyScope, offset: number): Promise<RulesPage<TeamRule>> {
    const { data, error } = await this.client.from("ai_team_rules").select(COLUMNS)
      .eq("business_id", scope.businessId)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset, offset + RULE_PAGE_SIZE);
    if (error) throw error;
    const rows = data as RuleRow[];
    return { items: rows.slice(0, RULE_PAGE_SIZE).map(toRule),
      nextOffset: rows.length > RULE_PAGE_SIZE ? offset + RULE_PAGE_SIZE : null };
  }

  async listEvents(scope: PolicyScope, offset: number): Promise<RulesPage<RuleEvent>> {
    const { data, error } = await this.client.from("ai_rule_events")
      .select("id, rule_id, actor_user_id, agent_id, instruction_snapshot, previous_status, new_status, version, created_at")
      .eq("business_id", scope.businessId)
      .order("id", { ascending: false })
      .range(offset, offset + RULE_PAGE_SIZE);
    if (error) throw error;
    const rows = data as EventRow[];
    return { items: rows.slice(0, RULE_PAGE_SIZE).map(toEvent),
      nextOffset: rows.length > RULE_PAGE_SIZE ? offset + RULE_PAGE_SIZE : null };
  }

  async listActiveRules(scope: PolicyScope): Promise<TeamRule[]> {
    const { data, error } = await this.client.from("ai_team_rules").select(COLUMNS)
      .eq("business_id", scope.businessId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    return (data as RuleRow[]).map(toRule);
  }

  async findRule(scope: PolicyScope, id: string): Promise<TeamRule | null> {
    const { data, error } = await this.client.from("ai_team_rules").select(COLUMNS)
      .eq("id", id).eq("business_id", scope.businessId).maybeSingle();
    if (error) throw error;
    return data ? toRule(data as RuleRow) : null;
  }

  async createDraft(scope: PolicyScope, agentId: RuleAgent, instruction: string): Promise<TeamRule> {
    const { data, error } = await this.client.from("ai_team_rules")
      .insert({ business_id: scope.businessId, created_by: scope.ownerUserId,
        agent_id: agentId, instruction, status: "draft", version: 1 })
      .select(COLUMNS).single();
    if (error) throw error;
    return toRule(data as RuleRow);
  }

  async compareAndSetStatus(scope: PolicyScope, id: string, version: number, status: RuleStatus):
    Promise<TeamRule | null> {
    // DB BEFORE UPDATE trigger checks state machine and immutable rule identity,
    // assigns reviewing auth.uid(), increments version, and writes audit event.
    const { data, error } = await this.client.from("ai_team_rules")
      .update({ status }).eq("id", id).eq("business_id", scope.businessId)
      .eq("version", version).select(COLUMNS).maybeSingle();
    if (error) throw error;
    return data ? toRule(data as RuleRow) : null;
  }
}
