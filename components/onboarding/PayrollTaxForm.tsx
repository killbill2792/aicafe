"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { savePayrollCostAssumption } from "@/lib/actions/payrollCosts";
import { employerCostPercentFromInput } from "@/lib/calc/scheduling/ruleInputValues";
import {useLocale} from "next-intl";

export default function PayrollTaxForm({
  initialPercent,
  labels,
}: {
  initialPercent: number;
  labels: { label: string; hint: string; continueLabel: string; invalid: string; saveFailed: string };
}) {
  const router = useRouter();
  const locale = useLocale();
  const [percent, setPercent] = useState(new Intl.NumberFormat(locale,{useGrouping:false,maximumFractionDigits:4}).format(initialPercent));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const rate = employerCostPercentFromInput(percent);
  const valid = rate !== null;

  function handleContinue() {
    if (!valid) { setError(labels.invalid); return; }
    setError("");
    startTransition(async () => {
      try {
        const result = await savePayrollCostAssumption({ employerCostPercent: rate });
        if (result.ok) router.push("/onboarding?step=4");
        else setError(labels.saveFailed);
      } catch { setError(labels.saveFailed); }
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-card-lg bg-card p-5">
      <label className="flex items-center justify-between gap-3">
        <span className="text-base font-semibold">{labels.label}</span>
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            value={percent}
            onChange={(e) => { setPercent(e.target.value); setError(""); }}
            aria-invalid={!!error}
            aria-describedby={error ? "onboarding-payroll-error" : undefined}
            className={`h-12 w-20 rounded-xl border px-2 text-end text-lg font-bold ${error ? "border-neg" : "border-line"}`}
          />
          <span className="text-lg font-bold">%</span>
        </div>
      </label>
      <p className="text-sm text-ink-muted">{labels.hint}</p>
      {error && <p id="onboarding-payroll-error" role="alert" className="text-neg">{error}</p>}
      <button type="button" onClick={handleContinue} disabled={isPending} className="h-14 rounded-full bg-accent text-lg font-bold text-on-accent">
        {labels.continueLabel}
      </button>
    </div>
  );
}
