import { describe, expect, it } from "vitest";
import { supervisorChatConfigStatus } from "./readiness";

describe("Supervisor chat deployment readiness", () => {
  const configured = { configuredSupabase: true, serviceRolePresent: true };
  it("does not permanently disable production chat when an optional flag is missing", () => {
    expect(supervisorChatConfigStatus(configured)).toEqual({ enabled: true, reason: null });
    expect(supervisorChatConfigStatus({ ...configured, featureFlag: "true" }))
      .toEqual({ enabled: true, reason: null });
  });
  it("preserves explicit emergency opt-out", () => {
    expect(supervisorChatConfigStatus({ ...configured, featureFlag: "false" }))
      .toEqual({ enabled: false, reason: "explicitly_disabled" });
    expect(supervisorChatConfigStatus({ ...configured, featureFlag: " FALSE " }).enabled).toBe(false);
  });
  it("fails closed when Supabase or the privileged server writer is missing", () => {
    expect(supervisorChatConfigStatus({ ...configured, serviceRolePresent: false }))
      .toEqual({ enabled: false, reason: "server_writer_unconfigured" });
    expect(supervisorChatConfigStatus({ ...configured, configuredSupabase: false }))
      .toEqual({ enabled: false, reason: "supabase_unconfigured" });
    expect(supervisorChatConfigStatus({ configuredSupabase: false, serviceRolePresent: false }).enabled).toBe(false);
  });
});
