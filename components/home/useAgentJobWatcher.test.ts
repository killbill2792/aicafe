import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJob } from "@/lib/ai/agent/jobState";

const hooks = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  seen: [] as unknown[],
  configured: false,
  realtimeChanged: null as null | (() => void),
  realtimeStatus: null as null | ((status: string) => void),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
  },
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(initial: T) => [initial, (value: T) => { hooks.seen.push(value); }],
}));
vi.mock("@/lib/supabase/client", () => {
  const channel = {
    on: (_event: string, _filter: unknown, callback: () => void) => {
      hooks.realtimeChanged = callback;
      return channel;
    },
    subscribe: (callback: (status: string) => void) => {
      hooks.realtimeStatus = callback;
      return channel;
    },
  };
  return {
    isSupabaseConfigured: () => hooks.configured,
    createBrowserSupabaseClient: () => ({
      channel: () => channel,
      removeChannel: async () => undefined,
    }),
  };
});

import { useAgentJobWatcher, JOB_POLL_MS, JOB_WATCH_MAX_MS } from "./useAgentJobWatcher";
import { AGENT_JOB_STALE_MS } from "@/lib/ai/agent/jobState";

const thread = "11111111-1111-4111-8111-111111111111";
const baseJob = (): AgentJob => ({
  id: "55555555-5555-4555-8555-555555555555", threadId: thread,
  ownerMessageId: "66666666-6666-4666-8666-666666666666",
  status: "running", attempt: 1, errorCode: null, replyMessageId: null,
  progress: [], inbox: [], consumed: [], heartbeatAt: new Date(Date.now()).toISOString(),
  createdAt: new Date(Date.now()).toISOString(),
});
const lastSeenJob = () => (hooks.seen.at(-1) as { threadId: string; job: AgentJob | null }).job;
const settle = () => vi.fn((_job: AgentJob) => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
  hooks.cleanups = [];
  hooks.seen = [];
  hooks.configured = false;
  hooks.realtimeChanged = null;
  hooks.realtimeStatus = null;
});
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAgentJobWatcher resume and recovery", () => {
  it("notifies once when the first observed job is already terminal", async () => {
    const done = { ...baseJob(), status: "done" as const, replyMessageId: "77777777-7777-4777-8777-777777777777" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ job: done })));
    const onSettled = settle();
    useAgentJobWatcher(thread, true, onSettled);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSeenJob()?.status).toBe("done");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(done);
    await vi.advanceTimersByTimeAsync(JOB_WATCH_MAX_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("polls after an initial lookup error instead of abandoning the job", async () => {
    const running = baseJob();
    const done = { ...running, status: "done" as const };
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return Response.json({ job: calls === 2 ? running : done });
    }));
    const onSettled = settle();
    useAgentJobWatcher(thread, true, onSettled);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(calls).toBe(2);
    expect(lastSeenJob()?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(lastSeenJob()?.status).toBe("done");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("rechecks at the 180s stale deadline even when Realtime is subscribed", async () => {
    hooks.configured = true;
    const running = baseJob();
    const staleAt = Date.parse(running.heartbeatAt) + AGENT_JOB_STALE_MS;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return Response.json({ job: Date.now() > staleAt
        ? { ...running, status: "failed", errorCode: "timeout" } : running });
    }));
    const onSettled = settle();
    useAgentJobWatcher(thread, true, onSettled);
    await vi.advanceTimersByTimeAsync(0);
    hooks.realtimeStatus?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(0);
    const beforeStale = calls;
    await vi.advanceTimersByTimeAsync(AGENT_JOB_STALE_MS);
    expect(calls).toBe(beforeStale);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(beforeStale + 1);
    expect(lastSeenJob()?.status).toBe("failed");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when a stale-deadline recheck fails with Realtime subscribed", async () => {
    hooks.configured = true;
    const running = baseJob();
    const done = { ...running, status: "done" as const };
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 3) throw new Error("temporary outage");
      return Response.json({ job: calls > 3 ? done : running });
    }));
    const onSettled = settle();
    useAgentJobWatcher(thread, true, onSettled);
    await vi.advanceTimersByTimeAsync(0);
    hooks.realtimeStatus?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(AGENT_JOB_STALE_MS + 1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(calls).toBe(4);
    expect(lastSeenJob()?.status).toBe("done");
    expect(onSettled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(JOB_WATCH_MAX_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("enforces the 240s limit with a healthy but silent Realtime socket", async () => {
    hooks.configured = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ job: baseJob() })));
    const onSettled = settle();
    useAgentJobWatcher(thread, true, onSettled);
    await vi.advanceTimersByTimeAsync(0);
    hooks.realtimeStatus?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(JOB_WATCH_MAX_MS);
    expect(lastSeenJob()).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
