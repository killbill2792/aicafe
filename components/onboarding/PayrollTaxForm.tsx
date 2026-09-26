"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { setPayrollTaxRate } from "@/lib/actions/onboarding";

export default function PayrollTaxForm({
  initialPercent,
  labels,
}: {
  initialPercent: number;
  labels: { label: string; hint: string; continueLabel: string };
}) {
  const router = useRouter();
  const [percent, setPercent] = useState(String(initialPercent));
  const [isPending, startTransition] = useTransition();

  function handleContinue() {
    startTransition(async () => {
      await setPayrollTaxRate(Number(percent) || 12);
      router.push("/onboarding?step=4");
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-card-lg bg-card p-5">
      <label className="flex items-center justify-between gap-3">
        <span className="text-base font-semibold">{labels.label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className="h-12 w-20 rounded-xl border border-line px-2 text-end text-lg font-bold"
          />
          <span className="text-lg font-bold">%</span>
        </div>
      </label>
      <p className="text-sm text-ink-muted">{labels.hint}</p>
      <button type="button" onClick={handleContinue} disabled={isPending} className="h-14 rounded-full bg-ink text-lg font-bold text-paper">
        {labels.continueLabel}
      </button>
    </div>
  );
}
