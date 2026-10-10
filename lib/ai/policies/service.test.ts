import { describe, expect, it, vi } from "vitest";
import {
  createRuleInput, evaluateSupervisorPermission, reviewRuleInput,
  type TeamRule,
} from "./contracts";
import {
  RuleConflict, RuleNotFound, RuleTransitionDenied, targetRuleStatus,
  TeamRulesService, type TeamRulesRepository,
} from "./service";

const owner = { businessId: "cafe-a", ownerUserId: "owner-a" };
const draft: TeamRule = {
  id: "rule-a", agentId: "alex", instruction: "Ask me before changing any price",
  status: "draft", version: 1, createdBy: "owner-a", reviewedBy: null,
  createdAt: "2026-10-10T06:00:00Z", updatedAt: "2026-10-10T06:00:00Z",
};
function repository(): TeamRulesRepository {
  return {
    listRules: vi.fn(async () => ({ items: [draft], nextOffset: null })),
    listEvents: vi.fn(async () => ({ items: [], nextOffset: null })),
    findRule: vi.fn(async () => draft),
    createDraft: vi.fn(async () => draft),
    compareAndSetStatus: vi.fn(async (_scope, _id, version, status) => ({
      ...draft, version: version + 1, status, reviewedBy: owner.ownerUserId,
    })),
  };
}
describe("Phase 5 owner rules and approval state machine", () => {
  it("requires trusted owner and café scope", () => {
    expect(() => new TeamRulesService(repository(), { ...owner, businessId: "" })).toThrow();
    expect(() => new TeamRulesService(repository(), { ...owner, ownerUserId: "" })).toThrow();
  });

  it("never accepts a different business ID, role, approval or arbitrary tool in the request", () => {
    expect(createRuleInput.safeParse({ agentId: "alex", instruction: draft.instruction }).success).toBe(true);
    expect(createRuleInput.safeParse({ agentId: "alex", instruction: draft.instruction, businessId: "other" }).success).toBe(false);
    expect(createRuleInput.safeParse({ agentId: "alex", instruction: draft.instruction, status: "active" }).success).toBe(false);
    expect(createRuleInput.safeParse({ agentId: "admin", instruction: draft.instruction }).success).toBe(false);
    expect(reviewRuleInput.safeParse({ expectedVersion: 1, decision: "execute" }).success).toBe(false);
    expect(reviewRuleInput.safeParse({ expectedVersion: 1, decision: "approve", actor: "other" }).success).toBe(false);
  });

  it("trims and validates human-readable instruction length", () => {
    expect(createRuleInput.parse({ agentId: "supervisor", instruction: "  Always tell me first  " })
      .instruction).toBe("Always tell me first");
    expect(createRuleInput.safeParse({ agentId: "supervisor", instruction: "    " }).success).toBe(false);
    expect(createRuleInput.safeParse({ agentId: "supervisor", instruction: "x".repeat(1001) }).success).toBe(false);
  });

  it("creates only a draft with server-provided owner scope", async () => {
    const repo = repository();
    const result = await new TeamRulesService(repo, owner).createDraft("alex", draft.instruction);
    expect(result.status).toBe("draft");
    expect(repo.createDraft).toHaveBeenCalledWith(owner, "alex", draft.instruction);
  });

  it("requires an explicit review to activate, reject, pause and resume", () => {
    expect(targetRuleStatus("draft", "approve")).toBe("active");
    expect(targetRuleStatus("draft", "reject")).toBe("rejected");
    expect(targetRuleStatus("active", "pause")).toBe("paused");
    expect(targetRuleStatus("paused", "resume")).toBe("active");
  });

  it("rejects all unsupported transitions, including a rejected rule resurrection", () => {
    for (const [status, action] of [
      ["draft", "pause"], ["active", "approve"], ["active", "reject"],
      ["rejected", "approve"], ["rejected", "resume"], ["paused", "reject"],
    ] as const) {
      expect(() => targetRuleStatus(status, action)).toThrow(RuleTransitionDenied);
    }
  });

  it("denies cross-owner/café lookup with no updates", async () => {
    const repo = repository();
    repo.findRule = vi.fn(async () => null);
    await expect(new TeamRulesService(repo, { businessId: "other", ownerUserId: "other" })
      .reviewRule(draft.id, 1, "approve")).rejects.toBeInstanceOf(RuleNotFound);
    expect(repo.compareAndSetStatus).not.toHaveBeenCalled();
  });

  it("rejects stale review versions and doesn't lose the existing owner decision", async () => {
    const repo = repository();
    await expect(new TeamRulesService(repo, owner).reviewRule(draft.id, 2, "approve"))
      .rejects.toBeInstanceOf(RuleConflict);
    expect(repo.compareAndSetStatus).not.toHaveBeenCalled();
  });

  it("atomically approves a matching rule version", async () => {
    const repo = repository();
    const saved = await new TeamRulesService(repo, owner).reviewRule(draft.id, 1, "approve");
    expect(saved.status).toBe("active");
    expect(saved.version).toBe(2);
    expect(repo.compareAndSetStatus).toHaveBeenCalledWith(owner, draft.id, 1, "active");
  });

  it("reports a simultaneous approval race instead of silently overwriting it", async () => {
    const repo = repository();
    repo.compareAndSetStatus = vi.fn(async () => null);
    await expect(new TeamRulesService(repo, owner).reviewRule(draft.id, 1, "approve"))
      .rejects.toBeInstanceOf(RuleConflict);
  });

  it("rejects inconsistent database transition outcomes", async () => {
    const repo = repository();
    repo.compareAndSetStatus = vi.fn(async () => ({ ...draft, status: "active", version: 8 }));
    await expect(new TeamRulesService(repo, owner).reviewRule(draft.id, 1, "approve"))
      .rejects.toBeInstanceOf(RuleConflict);
  });

  it("keeps read and audit history scoped to the authorized owner's café", async () => {
    const repo = repository();
    const service = new TeamRulesService(repo, owner);
    expect((await service.listRules(20)).items).toEqual([draft]);
    await service.listEvents(20);
    expect(repo.listRules).toHaveBeenCalledWith(owner, 20);
    expect(repo.listEvents).toHaveBeenCalledWith(owner, 20);
  });

  it("permits only read-only AI tools, even after an owner approves a rule", () => {
    for (const action of ["read_cafe_state", "read_pricing", "read_team_tasks"] as const) {
      expect(evaluateSupervisorPermission(action)).toEqual({
        permitted: true, needsOwnerApproval: false, reason: "trusted_read_only",
      });
    }
    for (const action of [
      "change_price", "change_staff_schedule", "contact_supplier",
      "write_payroll", "update_pos", "unknown",
    ] as const) {
      expect(evaluateSupervisorPermission(action)).toMatchObject({
        permitted: false, needsOwnerApproval: true,
      });
    }
  });
});
