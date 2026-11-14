"use client";
import { useEffect, useState } from "react";
import type { OwnerWorkItem } from "@/lib/ai/supervisor/runs/ownerWorkView";

export const WORK_VISIBLE_POLL_MS = 5_000;
type WorkRead = { threadId: string; items: OwnerWorkItem[]; unavailable: boolean };

/** Reading progress never *drives* the work; the existing durable worker does.
 * Refresh, focus and reconnect rehydrate this read-only view. */
export function useSupervisorWork(threadId: string | null, active: boolean) {
  const [seen, setSeen] = useState<WorkRead | null>(null);
  useEffect(() => {
    if (!active || !threadId) return;
    const controller = new AbortController();
    let checking = false;
    let stopped = false;
    const read = async () => {
      if (stopped || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const response = await fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/work", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("supervisor_work_unavailable");
        const body = await response.json() as { work?: OwnerWorkItem[] };
        if (!Array.isArray(body.work)) throw new Error("supervisor_work_invalid");
        if (!stopped) setSeen({ threadId, items: body.work, unavailable: false });
      } catch {
        // Keep previous persisted status visible, but clearly mark it as stale.
        // Never tell the owner the action failed (or succeeded) on network loss.
        if (!stopped && !controller.signal.aborted)
          setSeen(current => ({ threadId, items: current?.threadId === threadId ? current.items : [],
            unavailable: true }));
      } finally { checking = false; }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    const onFocus = () => { void read(); };
    void read();
    const timer = window.setInterval(() => { void read(); }, WORK_VISIBLE_POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, active]);
  return active && threadId && seen?.threadId === threadId
    ? { items: seen.items, unavailable: seen.unavailable }
    : { items: [] as OwnerWorkItem[], unavailable: false };
}
