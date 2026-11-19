"use client";
import { useEffect, useState } from "react";
import type { OwnerWorkItem } from "@/lib/ai/supervisor/runs/ownerWorkView";

export const WORK_VISIBLE_POLL_MS = 5_000;
type WorkRead = { key: string; items: OwnerWorkItem[]; unavailable: boolean };

/** Reading progress never *drives* the work; the existing durable worker does.
 * Refresh, focus and reconnect rehydrate this read-only view. */
export function useSupervisorWork(threadId: string | null, active: boolean, ownerWide = false) {
  const key = (threadId ?? "") + (ownerWide ? ":owner" : ":thread");
  const [seen, setSeen] = useState<WorkRead | null>(null);
  useEffect(() => {
    if (!active || !threadId) return;
    const controller = new AbortController();
    let checking = false;
    let stopped = false;
    let refreshPending = false;
    const markUnavailable = (clear = false) => setSeen(current => ({key,
      items: !clear && current?.key === key ? current.items : [],unavailable:true}));
    const read = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (checking) { refreshPending = true; return; }
      if (!navigator.onLine) { markUnavailable(); return; }
      checking = true;
      try {
        const response = await fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/work" + (ownerWide ? "?scope=owner" : ""), {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if ([401,403,404].includes(response.status)) {
          if (!stopped) markUnavailable(true);
          return;
        }
        if (!response.ok) throw new Error("supervisor_work_unavailable");
        const body = await response.json() as { work?: OwnerWorkItem[] };
        if (!Array.isArray(body.work)) throw new Error("supervisor_work_invalid");
        if (!stopped) setSeen({ key, items: body.work, unavailable: !navigator.onLine });
      } catch {
        // Keep previous persisted status visible, but clearly mark it as stale.
        // Never tell the owner the action failed (or succeeded) on network loss.
        if (!stopped && !controller.signal.aborted)
          markUnavailable();
      } finally {
        checking = false;
        if (refreshPending) { refreshPending = false; void read(); }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    const onFocus = () => { void read(); };
    void read();
    const onOffline = () => markUnavailable();
    const timer = window.setInterval(() => { void read(); }, ownerWide ? 25_000 : WORK_VISIBLE_POLL_MS);
    window.addEventListener("online", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, active, ownerWide, key]);
  return active && threadId && seen?.key === key
    ? { items: seen.items, unavailable: seen.unavailable, loading:false }
    : { items: [] as OwnerWorkItem[], unavailable: false, loading:Boolean(active && threadId) };
}
