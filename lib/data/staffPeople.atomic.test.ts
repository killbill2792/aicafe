import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSchedulingOwner } from "@/lib/scheduling/foundation.server";
import { setPersonActive } from "./staffPeople.server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/scheduling/foundation.server", () => ({
  requireSchedulingOwner: vi.fn(),
}));

const businessId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const employeeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function db() {
  const maybeSingle = vi.fn(async () => ({ data: { id: employeeId }, error: null }));
  const select = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ eq, select }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn((table: string) => {
    if (table !== "employees") throw new Error("unexpected independent schedule write");
    return { update };
  });
  return { from, update, eq, maybeSingle };
}
describe("staff deactivation is atomic across all authorized write paths", () => {
  beforeEach(() => vi.clearAllMocks());
  it("updates the employee once and leaves recurring cleanup to a database trigger", async () => {
    const fake = db();
    vi.mocked(requireSchedulingOwner).mockResolvedValue({
      businessId, supabase: fake as never,
    });
    const result = await setPersonActive({ id: employeeId, active: false });
    expect(result).toEqual({ ok: true, id: employeeId });
    expect(fake.from).toHaveBeenCalledTimes(1);
    expect(fake.from).toHaveBeenCalledWith("employees");
    expect(fake.update).toHaveBeenCalledWith({ active: false });
    expect(fake.eq).toHaveBeenCalledWith("business_id", businessId);
    expect(fake.eq).toHaveBeenCalledWith("id", employeeId);
  });
  it("fails closed on a refused employee write", async () => {
    const fake = db();
    fake.maybeSingle.mockResolvedValueOnce({ data: null as never, error: { message: "refused" } as never });
    vi.mocked(requireSchedulingOwner).mockResolvedValue({ businessId, supabase: fake as never });
    expect(await setPersonActive({ id: employeeId, active: false })).toEqual({
      ok: false, error: "storage_unavailable",
    });
  });
  it("has an idempotent atomic AFTER trigger in the same migration as the cleanup", () => {
    const migration = readFileSync(join(process.cwd(),
      "supabase/migrations/20261027000097_pr_e_inactive_schedule_cleanup.sql"), "utf8");
    expect(migration).toContain("AFTER UPDATE OF active ON public.employees");
    expect(migration).toContain("NEW.business_id");
    expect(migration).toContain("NEW.id");
    expect(migration).toContain("UPDATE public.staff_schedules");
    expect(migration).toContain("DROP TRIGGER IF EXISTS staff_disable_repeats_on_deactivation");
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });
});
