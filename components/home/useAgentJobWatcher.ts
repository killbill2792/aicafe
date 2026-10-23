"use client";
import { useEffect, useRef, useState } from "react";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { AgentJob } from "@/lib/ai/agent/jobState";

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
 * owner-scoped API (the row itself is never trusted from the socket); if the
 * socket is not up within a few seconds it falls back to a slow poll that only
 * runs while the job is still working, and never longer than JOB_WATCH_MAX_MS.
 * `onSettled` fires once when a watched running job finishes or fails.
 */
export function useAgentJobWatcher(threadId: string | null, active: boolean, onSettled: (job: AgentJob) => void) {
  const [seen, setSeen] = useState<{ threadId: string; job: AgentJob | null } | null>(null);
  const [version, setVersion] = useState(0);
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);

  useEffect(() => {
    if (!active || !threadId) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let sawRunning = false, finished = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let subscribed = false;
    let supabase: ReturnType<typeof createBrowserSupabaseClient> | null = null;
    let channel: ReturnType<ReturnType<typeof createBrowserSupabaseClient>["channel"]> | null = null;

    const stop = () => {
      finished = true;
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      poll = grace = null;
      if (supabase && channel) void supabase.removeChannel(channel);
      channel = null;
    };
    const read = async () => {
      if (finished) return null;
      try {
        const latest = await fetchLatestJob(threadId, controller.signal);
        if (controller.signal.aborted) return null;
        setSeen({ threadId, job: latest });
        if (latest?.status === "running") sawRunning = true;
        else if (sawRunning && latest) { stop(); settled.current(latest); }
        else stop();
        return latest;
      } catch { return null; /* keep the last known state; the next tick retries */ }
    };
    const startPolling = () => {
      if (poll || finished) return;
      poll = setInterval(() => {
        if (Date.now() - startedAt > JOB_WATCH_MAX_MS) { stop(); return; }
        void read();
      }, JOB_POLL_MS);
    };

    void read().then((latest) => {
      if (finished || latest?.status !== "running") return;
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
    return () => { controller.abort(); stop(); };
  }, [threadId, active, version]);

  // Derived, not reset in the effect: an inactive watcher or another thread shows nothing.
  const job = active && threadId && seen?.threadId === threadId ? seen.job : null;
  return { job, recheck: () => setVersion((v) => v + 1) };
}
