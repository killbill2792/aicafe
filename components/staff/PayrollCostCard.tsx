"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { savePayrollCostAssumption } from "@/lib/actions/payrollCosts";
import type { PayrollCostSettings } from "@/lib/data/getPayrollCostSettings";

function sourceLabel(source: string, labels: { owner: string; estimate: string; quickbooks: string; imported: string; connected: string }) {
  if (source === "owner_entered") return labels.owner;
  if (source === "system_estimate") return labels.estimate;
  if (source === "quickbooks") return labels.quickbooks;
  if (source === "imported") return labels.imported;
  if (source === "pos") return labels.connected;
  if (source === "legacy_actual") return labels.imported;
  return source;
}

export default function PayrollCostCard({
  settings,
  labels,
}: {
  settings: PayrollCostSettings;
  labels: {
    title: string;
    body: string;
    field: string;
    hint: string;
    source: string;
    ownerSource: string;
    estimateSource: string;
    quickbooksSource: string;
    importedSource: string;
    connectedSource: string;
    actualUsing: string;
    fallbackNote: string;
    save: string;
    saving: string;
    saved: string;
    invalid: string;
  };
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(Math.round(settings.employerCostRate * 10_000) / 100));
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const number = value.trim() === "" ? Number.NaN : Number(value);
  const valid = Number.isFinite(number) && number >= 0 && number <= 100;
  const sourceLabels = {
    owner: labels.ownerSource,
    estimate: labels.estimateSource,
    quickbooks: labels.quickbooksSource,
    imported: labels.importedSource,
    connected: labels.connectedSource,
  };

  function save() {
    setMessage(null);
    setError(null);
    if (!valid) {
      setError(labels.invalid);
      return;
    }
    startTransition(async () => {
      const result = await savePayrollCostAssumption({ employerCostPercent: number });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(labels.saved);
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <div>
        <h2 className="text-[17px] font-bold text-ink">{labels.title}</h2>
        <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.body}</p>
      </div>

      {settings.actualSources.length > 0 && (
        <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">
          {labels.actualUsing.replace(
            "{source}",
            settings.actualSources.map((source) => sourceLabel(source, sourceLabels)).join(", "),
          )}
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
        {labels.field}
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={100}
            step="0.1"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
          />
          <span className="font-bold text-ink-muted">%</span>
        </div>
        <span className="text-xs font-normal leading-snug text-ink-muted">{labels.hint}</span>
      </label>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-ink-muted">{labels.source}</span>
        <span className="rounded-full bg-paper px-2.5 py-1 font-bold text-ink">
          {sourceLabel(settings.fallbackSource, sourceLabels)}
        </span>
      </div>

      {settings.actualSources.length > 0 && <p className="text-xs leading-snug text-ink-muted">{labels.fallbackNote}</p>}
      {error && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {message && <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{message}</p>}

      <button
        type="button"
        onClick={save}
        disabled={isPending || !valid}
        className="min-h-12 self-start rounded-full bg-ink px-5 text-sm font-bold text-paper disabled:opacity-40"
      >
        {isPending ? labels.saving : labels.save}
      </button>
    </section>
  );
}
