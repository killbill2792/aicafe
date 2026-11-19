import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  type Row = { id?: string; run_id?: string; updated_at: string; status: string; step_key?: string; error_code?: string };
  const runs: Row[] = [], steps: Row[] = [];
  const unavailable = new Set<string>();
  const from = vi.fn((table: string) => {
    let rows = [...(table === "supervisor_runs" ? runs : steps)];
    const keys: string[] = [];
    const query = {
      select: () => query,
      in: (key: "status", values: string[]) => { rows = rows.filter(r => values.includes(r[key])); return query; },
      eq: (key: "status" | "step_key" | "error_code", value: string) => {
        rows = rows.filter(r => r[key] === value); return query;
      },
      order: (key: string) => { keys.push(key); return query; },
      limit: async (n: number) => {
        rows.sort((a, b) => {
          for (const key of keys) {
            const left = String(a[key as keyof Row]), right = String(b[key as keyof Row]);
            if (left !== right) return left < right ? -1 : 1;
          }
          return 0;
        });
        return { data: rows.slice(0, n), error: unavailable.has(table) ? { message: "unavailable" } : null };
      },
    };
    return query;
  });
  return { runs, steps, unavailable, from };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ from: db.from }) }));
import { selectNextDurableRun } from "./repository.server";

const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const date = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const active = (n: number, seconds: number) => ({ id: id(n), status: "pending", updated_at: date(seconds) });
const expired = (n: number, seconds: number) => ({
  run_id: id(n), status: "blocked", step_key: "owner_turn", error_code: "lease_expired", updated_at: date(seconds),
});

beforeEach(() => {
  db.runs.length = 0; db.steps.length = 0; db.unavailable.clear(); db.from.mockClear();
});

describe("existing durable run dispatch recovery lane", () => {
  it("selects expired reconciliation even with continuous ordinary arrivals", async () => {
    db.steps.push(expired(1, 0));
    for (let n = 2; n <= 1001; n++) db.runs.push(active(n, 1));
    expect(await selectNextDurableRun()).toEqual({ runId: id(1), recovery: true });
    expect(db.from.mock.calls.map(c => c[0])).toEqual(["supervisor_runs", "supervisor_run_steps"]);
  });
  it("does not let newer expired work displace older ordinary work", async () => {
    db.runs.push(active(1, 0)); db.steps.push(expired(2, 1));
    expect(await selectNextDurableRun()).toEqual({ runId: id(1), recovery: false });
  });
  it("prefers the recovery lane at equal timestamps and orders same-lane IDs", async () => {
    db.runs.push(active(1, 0)); db.steps.push(expired(3, 0), expired(2, 0));
    expect(await selectNextDurableRun()).toEqual({ runId: id(2), recovery: true });
  });
  it("never selects cancellation, revocation, budget blocks or other step keys", async () => {
    for (const [n, reason] of ["cancelled", "authorization_revoked", "budget_exceeded"].entries())
      db.steps.push({ ...expired(n + 1, 0), error_code: reason });
    db.steps.push({ ...expired(4, 0), step_key: "verify_report" });
    db.runs.push({ ...active(5, 0), status: "completed" }, { ...active(6, 0), status: "blocked" });
    expect(await selectNextDurableRun()).toBeNull();
  });
  it("fails closed when either lane cannot be read", async () => {
    db.runs.push(active(1, 0)); db.steps.push(expired(2, 1));
    db.unavailable.add("supervisor_run_steps");
    await expect(selectNextDurableRun()).rejects.toThrow("supervisor_worker_recovery_unavailable");
    db.unavailable.clear(); db.unavailable.add("supervisor_runs");
    await expect(selectNextDurableRun()).rejects.toThrow("supervisor_worker_queue_unavailable");
  });
});
