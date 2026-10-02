"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { respondToPriceReview } from "@/lib/actions/operatingTasks";

export default function PriceReviewActions({ taskId, keepLabel, laterLabel, errorLabel }: { taskId: string; keepLabel: string; laterLabel: string; errorLabel: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const router = useRouter();
  const decide = (decision: "keep_price" | "later") => startTransition(async () => {
    setError(false);
    const result = await respondToPriceReview({ taskId, decision });
    if (result.ok) router.refresh(); else setError(true);
  });
  return <div className="mt-2">
    <div className="grid grid-cols-2 gap-2">
      <button type="button" disabled={pending} onClick={() => decide("keep_price")} className="min-h-12 rounded-full border border-ink px-3 text-sm font-bold text-ink disabled:opacity-50">{keepLabel}</button>
      <button type="button" disabled={pending} onClick={() => decide("later")} className="min-h-12 rounded-full border border-line bg-card px-3 text-sm font-bold text-ink disabled:opacity-50">{laterLabel}</button>
    </div>
    {error && <p role="alert" className="mt-2 text-sm font-semibold text-warn">{errorLabel}</p>}
  </div>;
}
