"use client";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDot, Clock3, ShieldAlert } from "lucide-react";
import type { OwnerWorkItem, OwnerWorkStatus } from "@/lib/ai/supervisor/runs/ownerWorkView";
import en from "@/messages/en.json";

const statusCopy: Record<OwnerWorkStatus, string> = en.SupervisorWork.status;
const statusIcon = (status: OwnerWorkStatus) => {
  if (status === "verified_complete" || status === "source_resolved") return <CheckCircle2 size={17} aria-hidden="true" className="text-good" />;
  if (status === "uncertain" || status === "failed") return <ShieldAlert size={17} aria-hidden="true" className="text-ink-muted" />;
  if (status === "approval_required") return <AlertTriangle size={17} aria-hidden="true" className="text-ink-muted" />;
  if (status === "queued") return <Clock3 size={17} aria-hidden="true" className="text-ink-muted" />;
  return <CircleDot size={17} aria-hidden="true" className="text-ink-muted" />;
};

/** A read-only transcript companion, not a second approval, scheduler or
 * provider execution control. The existing proposal cards own owner action. */
export default function SupervisorWorkStatus({ items, unavailable, loading=false, showEmpty=false, onOpen, disabled=false }: {
  items: OwnerWorkItem[]; unavailable: boolean; loading?:boolean; showEmpty?:boolean;
  onOpen?:(item:OwnerWorkItem)=>void; disabled?:boolean;
}) {
  const [shown, setShown] = useState(5);
  const active = items.filter(item => !["answer_ready", "verified_complete", "source_resolved", "cancelled"].includes(item.status));
  const recent = items.filter(item => ["answer_ready", "verified_complete", "source_resolved", "cancelled"].includes(item.status)).slice(0, 2);
  const display = [...active.slice(0, shown), ...recent].slice(0, shown + 2);
  if (!display.length && !unavailable && !showEmpty) return null;
  return <section aria-label={en.SupervisorWork.heading}
    className="min-w-0 w-full space-y-2 rounded-2xl border border-line bg-surface p-3 sm:p-4">
    <h3 className="text-[15px] font-semibold text-ink">{en.SupervisorWork.heading}</h3>
    {loading && <p role="status">{en.SupervisorWork.copy.runChecking}</p>}
    {showEmpty && !loading && !unavailable && !display.length &&
      <p className="text-sm text-ink-muted">{en.SupervisorWork.heading}: 0</p>}
    {unavailable && <p role="status" className="text-[14px] text-ink-muted">
      {en.SupervisorWork.stale}
    </p>}
    <div className="space-y-2" aria-live="polite" aria-relevant="additions text">
      {display.map(item => <article key={item.id}
        className="min-w-0 space-y-1 rounded-xl border border-line p-3"
        data-work-status={item.status} data-work-kind={item.kind} data-work-id={item.id}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {statusIcon(item.status)}
          <strong className="text-[14px] text-ink">{statusCopy[item.status]}</strong>
          <span className="text-[13px] text-ink-muted">{item.title}</span>
        </div>
        {item.threadTitle && <p className="break-words text-[15px] font-semibold text-ink">{item.threadTitle}</p>}
        <p className="break-words text-[14px] leading-relaxed text-ink-muted">{item.detail}</p>
        <p className="break-words text-[13px] leading-relaxed text-ink-muted">{item.nextStep}</p>
        {item.proof && <p className="break-all text-[12px] text-ink-muted">
          {item.proof.kind === "verified_effect"
            ? en.SupervisorWork.effectReceipt : en.SupervisorWork.replyReceipt}
          {" "}{item.proof.ref}
        </p>}
        {onOpen && item.threadId && <button type="button" disabled={disabled || unavailable}
          aria-label={en.SupervisorChat.taskOpen+": "+(item.threadTitle??item.title)}
          onClick={()=>onOpen(item)} className="min-h-12 rounded-lg border border-line px-3 text-sm font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
          {en.SupervisorChat.taskOpen}
        </button>}
      </article>)}
    </div>
    {active.length > shown && <button type="button" onClick={() => setShown(n => n + 5)}
      className="min-h-12 rounded-lg border border-line px-3 py-2 text-[14px] font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
      {en.SupervisorWork.more}
    </button>}
  </section>;
}
