import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({
  process: vi.fn(), start: vi.fn(),
}));
vi.mock("@/lib/ai/supervisor/runs/worker.server", () => ({
  processOldestDurableRun: work.process,
  startDurableOwnerRun: work.start,
}));
import { GET, POST } from "./route";

const url = "https://example.test/api/cron/supervisor-run-worker";
const request = (method: "GET" | "POST", bearer?: string, body?: unknown) =>
  new Request(url, { method, headers: {
    ...(bearer ? { Authorization: bearer } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
const old = { secret: process.env.CRON_SECRET, flag: process.env.SUPERVISOR_RUN_WORKER_ENABLED };
const ownerMessageId = "00000000-0000-4000-8000-000000000111";
beforeEach(() => {
  work.process.mockReset().mockResolvedValue({ processed: 1, state: "completed" });
  work.start.mockReset().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000222", status: "pending" });
  process.env.CRON_SECRET = "private-test-cron-secret";
  delete process.env.SUPERVISOR_RUN_WORKER_ENABLED;
});
afterEach(() => {
  if (old.secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = old.secret;
  if (old.flag === undefined) delete process.env.SUPERVISOR_RUN_WORKER_ENABLED;
  else process.env.SUPERVISOR_RUN_WORKER_ENABLED = old.flag;
});

describe("durable Supervisor worker cron trust boundary", () => {
  it("rejects missing and incorrect bearer before creating any worker", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    expect((await POST(request("POST", "Bearer invalid", { ownerMessageId }))).status).toBe(401);
    expect(work.process).not.toHaveBeenCalled();
    expect(work.start).not.toHaveBeenCalled();
  });
  it("is off by default even for a valid cron credential", async () => {
    const token = "Bearer private-test-cron-secret";
    expect((await GET(request("GET", token))).status).toBe(503);
    expect((await POST(request("POST", token, { ownerMessageId }))).status).toBe(503);
    expect(work.process).not.toHaveBeenCalled();
    expect(work.start).not.toHaveBeenCalled();
  });
  it("processes bounded work when explicitly enabled", async () => {
    process.env.SUPERVISOR_RUN_WORKER_ENABLED = "true";
    const response = await GET(request("GET", "Bearer private-test-cron-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 1, state: "completed" });
    expect(work.process).toHaveBeenCalledOnce();
  });
  it("accepts only a stored owner-message key; never request-supplied tenant, plan or effects", async () => {
    process.env.SUPERVISOR_RUN_WORKER_ENABLED = "true";
    const token = "Bearer private-test-cron-secret";
    expect((await POST(request("POST", token, { ownerMessageId, businessId: ownerMessageId }))).status).toBe(400);
    expect((await POST(request("POST", token, { ownerMessageId: "not-a-uuid" }))).status).toBe(400);
    expect(work.start).not.toHaveBeenCalled();
    const response = await POST(request("POST", token, { ownerMessageId }));
    expect(response.status).toBe(202);
    expect(work.start).toHaveBeenCalledExactlyOnceWith(ownerMessageId);
    expect(await response.json()).toMatchObject({ status: "pending" });
  });
  it("does not disclose internal failures or run any work on invalid config", async () => {
    process.env.SUPERVISOR_RUN_WORKER_ENABLED = "true";
    work.process.mockRejectedValueOnce(new Error("sensitive tenant secrets"));
    const response = await GET(request("GET", "Bearer private-test-cron-secret"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });
});
