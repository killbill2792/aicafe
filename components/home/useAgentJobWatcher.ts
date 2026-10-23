"use client";
import { useEffect, useRef, useState } from "react";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { AGENT_JOB_STALE_MS, type AgentJob } from "@/lib/ai/agent/jobState";

/** How long the browser keeps watching one background turn before it stops and
 * asks once more. Longer than the server's own 150s limit plus the stale window. */
export const JOB_WATCH_MAX_MS = 240_000;
export const JOB_POLL_MS = 3_000;
export const JOB_REALTIME_GRACE_MS = 4_000;

async function fetchLatestJob(threadId: string, signal: AbortSignal): Promise<AgentJob | null> {
  const response = await fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/jobs",
    { cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new Error("agent_job_read_failed");
  const body = await response.json() as { job?: AgentJob | null };
  return body.job ?? null;
}

/**
 * Watches the latest background turn of a conversation after a reload or when
 * the owner comes back. Realtime row changes trigger a re-read through the
 * owner-scoped API (the row itself is never trusted from the socket). A stale
 * heartbeat is rechecked even with a healthy socket; errors use bounded polling.
 * `onSettled` fires once per terminal job/attempt, including an initial terminal read.
 */
export function useAgentJobWatcher(threadId: string | null, active: boolean, onSettled: (job: AgentJob) => void) {
  const [seen, setSeen] = useState<{ threadId: string; job: AgentJob | null } | null>(null);
  const [version, setVersion] = useState(0);
  const settled = useRef(onSettled);
  const notified = useRef(new Set<string>());
  useEffect(() => { settled.current = onSettled; }, [onSettled]);

  useEffect(() => {
    if (!active || !threadId) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let finished = false;
    let lastRunning: AgentJob | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let limit: ReturnType<typeof setTimeout> | null = null;
    let subscribed = false;
    let supabase: ReturnType<typeof createBrowserSupabaseClient> | null = null;
    let channel: ReturnType<ReturnType<typeof createBrowserSupabaseClient>["channel"]> | null = null;

    const stop = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      if (watchdog) clearTimeout(watchdog);
      if (limit) clearTimeout(limit);
      poll = grace = watchdog = limit = null;
      if (supabase && channel) void supabase.removeChannel(channel);
      channel = null;
    };
    const notifyOnce = (job: AgentJob) => {
      const key = [threadId, job.id, job.attempt, job.status, job.replyMessageId].join(":");
      if (notified.current.has(key)) return;
      notified.current.add(key);
      settled.current(job);
    };
    const read = async (): Promise<AgentJob | null | undefined> => {
      if (finished) return undefined;
      try {
        const latest = await fetchLatestJob(threadId, controller.signal);
        if (controller.signal.aborted || finished) return undefined;
        setSeen({ threadId, job: latest });
        if (latest?.status === "running") {
          lastRunning = latest;
          scheduleWatchdog(latest);
        } else {
          stop();
          if (latest) notifyOnce(latest);
        }
        return latest;
      } catch { return undefined; /* a failed lookup must never stop retries */ }
    };
    const scheduleWatchdog = (job: AgentJob) => {
      if (watchdog) clearTimeout(watchdog);
      const heartbeat = Date.parse(job.heartbeatAt);
      const staleAt = Number.isFinite(heartbeat) ? heartbeat + AGENT_JOB_STALE_MS : startedAt + AGENT_JOB_STALE_MS;
      const timeLeft = startedAt + JOB_WATCH_MAX_MS - Date.now();
      if (timeLeft <= 0) return;
      // A socket can remain SUBSCRIBED when its server worker dies: always re-read.
      const delay = staleAt <= Date.now() ? JOB_POLL_MS : staleAt - Date.now() + 1;
      watchdog = setTimeout(() => { watchdog = null; void read(); }, Math.min(delay, timeLeft));
    };
    const startPolling = () => {
      if (poll || finished) return;
      poll = setInterval(() => { void read(); }, JOB_POLL_MS);
    };

    // A nonresponding network and a healthy-but-silent Realtime socket must both
    // terminate after the same bounded watch. An unconfirmed running job becomes
    // retryable locally instead of leaving the owner stuck forever.
    limit = setTimeout(() => {
      if (finished) return;
      if (lastRunning) {
        const timedOut: AgentJob = { ...lastRunning, status: "failed", errorCode: "timeout" };
        setSeen({ threadId, job: timedOut });
        notifyOnce(timedOut);
      }
      stop();
    }, JOB_WATCH_MAX_MS);

    void read().then((latest) => {
      if (finished) return;
      if (latest === undefined) { startPolling(); return; }
      if (latest?.status !== "running") return;
      if (isSupabaseConfigured()) {
        try {
          supabase = createBrowserSupabaseClient();
          channel = supabase.channel("agent-job:" + threadId)
            .on("postgres_changes", { event: "*", schema: "public", table: "ai_agent_jobs",
              filter: "thread_id=eq." + threadId }, () => { void read(); })
            .subscribe((status) => {
              if (status === "SUBSCRIBED") { subscribed = true; void read(); }
              else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") startPolling();
            });
        } catch { startPolling(); }
      }
      grace = setTimeout(() => { if (!subscribed) startPolling(); }, JOB_REALTIME_GRACE_MS);
    });
    return stop;
  }, [threadId, active, version]);

  // Derived, not reset in the effect: an inactive watcher or another thread shows nothing.
  const job = active && threadId && seen?.threadId === threadId ? seen.job : null;
  return { job, recheck: () => setVersion((v) => v + 1) };
}
