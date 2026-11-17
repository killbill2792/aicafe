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
export default function SupervisorWorkStatus({ items, unavailable }: {
  items: OwnerWorkItem[]; unavailable: boolean;
}) {
  const [shown, setShown] = useState(5);
  const active = items.filter(item => !["answer_ready", "verified_complete", "source_resolved", "cancelled"].includes(item.status));
  const recent = items.filter(item => ["answer_ready", "verified_complete", "source_resolved", "cancelled"].includes(item.status)).slice(0, 2);
  const display = [...active.slice(0, shown), ...recent].slice(0, shown + 2);
  if (!display.length && !unavailable) return null;
  return <section aria-label={en.SupervisorWork.heading}
    className="min-w-0 w-full space-y-2 rounded-2xl border border-line bg-surface p-3 sm:p-4">
    <h3 className="text-[15px] font-semibold text-ink">{en.SupervisorWork.heading}</h3>
    {unavailable && <p role="status" className="text-[14px] text-ink-muted">
      {en.SupervisorWork.stale}
    </p>}
    <div className="space-y-2" aria-live="polite" aria-relevant="text">
      {display.map(item => <article key={item.id}
        className="min-w-0 space-y-1 rounded-xl border border-line p-3"
        data-work-status={item.status} data-work-kind={item.kind}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {statusIcon(item.status)}
          <strong className="text-[14px] text-ink">{statusCopy[item.status]}</strong>
          <span className="text-[13px] text-ink-muted">{item.title}</span>
        </div>
        <p className="break-words text-[14px] leading-relaxed text-ink-muted">{item.detail}</p>
        <p className="break-words text-[13px] leading-relaxed text-ink-muted">{item.nextStep}</p>
        {item.proof && <p className="break-all text-[12px] text-ink-muted">
          {item.proof.kind === "verified_effect"
            ? en.SupervisorWork.effectReceipt : en.SupervisorWork.replyReceipt}
          {" "}{item.proof.ref}
        </p>}
      </article>)}
    </div>
    {active.length > shown && <button type="button" onClick={() => setShown(n => n + 5)}
      className="rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-ink">
      {en.SupervisorWork.more}
    </button>}
  </section>;
}
