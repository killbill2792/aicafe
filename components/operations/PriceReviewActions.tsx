"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { respondToPriceReview } from "@/lib/actions/operatingTasks";

export default function PriceReviewActions({ taskId, keepLabel, laterLabel, snoozeLabels, cancelLabel, errorLabel }: { taskId: string; keepLabel: string; laterLabel: string; snoozeLabels: { seven: string; thirty: string; change: string }; cancelLabel: string; errorLabel: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const router = useRouter();
  const [choosingSnooze, setChoosingSnooze] = useState(false);
  const decide = (decision: "keep_price" | "later_7" | "later_30" | "later_change") => startTransition(async () => {
    setError(false);
    const result = await respondToPriceReview({ taskId, decision });
    if (result.ok) router.refresh(); else setError(true);
  });
  return <div className="mt-2">
    <div className="grid grid-cols-2 gap-2">
      <button type="button" disabled={pending} onClick={() => decide("keep_price")} className="min-h-12 rounded-full border border-ink px-3 text-sm font-bold text-ink disabled:opacity-50">{keepLabel}</button>
      <button type="button" disabled={pending} onClick={() => setChoosingSnooze(true)} className="min-h-12 rounded-full border border-line bg-card px-3 text-sm font-bold text-ink disabled:opacity-50">{laterLabel}</button>
    </div>
    {choosingSnooze && <div className="mt-2 flex flex-col gap-2 rounded-2xl border border-line bg-card p-2" role="group" aria-label={laterLabel}>
      <button type="button" className="min-h-12 rounded-xl text-start font-semibold" onClick={() => decide("later_7")}>{snoozeLabels.seven}</button>
      <button type="button" className="min-h-12 rounded-xl text-start font-semibold" onClick={() => decide("later_30")}>{snoozeLabels.thirty}</button>
      <button type="button" className="min-h-12 rounded-xl text-start font-semibold" onClick={() => decide("later_change")}>{snoozeLabels.change}</button>
      <button type="button" className="min-h-12 rounded-xl text-ink-muted" onClick={() => setChoosingSnooze(false)}>{cancelLabel}</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm font-semibold text-warn">{errorLabel}</p>}
  </div>;
}
