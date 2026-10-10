import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
import {
  deriveInitialThreadTitle, estimateSupervisorCostMicros, summarizeSupervisorUsage,
} from "./usage.server";

describe("Private per-café Supervisor consumption telemetry", () => {
  it("produces a safe first-message title without another model call", () => {
    expect(deriveInitialThreadTitle(" Hi, how many products did we sell today? ")).toBe(
      "Hi, how many products did we sell today?");
    expect(deriveInitialThreadTitle("a".repeat(200)).length).toBeLessThanOrEqual(120);
    expect(deriveInitialThreadTitle("  hello\nthere\r ")).toBe("hello there");
  });
  it("stores integer micros only when both configured token rates are valid", () => {
    expect(estimateSupervisorCostMicros(1000, 500, "0.4", "1.6")).toBe(1200);
    expect(estimateSupervisorCostMicros(1000, 500, undefined, "1.6")).toBeNull();
    expect(estimateSupervisorCostMicros(1000, 500, "-1", "1.6")).toBeNull();
    expect(estimateSupervisorCostMicros(1000, 500, "not rate", "1.6")).toBeNull();
  });
  it("reports unknown rather than fabricated cost for partially priced calls", () => {
    expect(summarizeSupervisorUsage([
      { input_tokens: 100, output_tokens: 30, estimated_cost_micros: 88 },
      { input_tokens: 200, output_tokens: 50, estimated_cost_micros: null },
    ])).toEqual({ requests: 2, inputTokens: 300, outputTokens: 80, estimatedCostMicros: null });
    expect(summarizeSupervisorUsage([
      { input_tokens: 100, output_tokens: 50, estimated_cost_micros: 120 },
    ])).toMatchObject({ requests: 1, estimatedCostMicros: 120 });
  });
  it("migration grants only SELECT to authenticated owners and blocks client writes", () => {
    const sql = readFileSync("supabase/migrations/20261010000038_ai_usage_telemetry.sql", "utf8");
    expect(sql).toContain("alter table ai_usage_events enable row level security");
    expect(sql).toContain("m.role = 'owner'");
    expect(sql).toContain("owner_user_id = (select auth.uid())");
    expect(sql).toContain("revoke insert, update, delete on ai_usage_events from authenticated");
    expect(sql).toContain("owner_message_id uuid not null unique");
  });
});
