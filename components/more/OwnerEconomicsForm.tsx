"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { saveOwnerEconomicsSettings } from "@/lib/actions/ownerEconomics";
import type { OwnerEconomicsSettings } from "@/lib/data/getOwnerEconomicsSettings";
import { buildPricingViewModel } from "@/lib/viewmodels/pricingViewModel";

type Labels = {
  currentMargin: string;
  currentMarginMissing: string;
  actual: string;
  estimated: string;
  targetMargin: string;
  targetMarginHint: string;
  defaultAssumption: string;
  ownerConfirmed: string;
  payrollBurden: string;
  payrollBurdenHint: string;
  payrollEstimated: string;
  scenarioTitle: string;
  scenarioHint: string;
  scenarioNoHistory: string;
  item: string;
  productCost: string;
  currentPrice: string;
  suggestedPrice: string;
  change: string;
  save: string;
  saving: string;
  saved: string;
  invalid: string;
};

function percentLabel(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

export default function OwnerEconomicsForm({
  settings,
  labels,
}: {
  settings: OwnerEconomicsSettings;
  labels: Labels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [targetMargin, setTargetMargin] = useState(String(Math.round(settings.targetOperatingMargin * 10_000) / 100));
  const [payrollBurden, setPayrollBurden] = useState(String(Math.round(settings.payrollTaxRate * 10_000) / 100));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const targetNumber = targetMargin.trim() === "" ? Number.NaN : Number(targetMargin);
  const payrollNumber = payrollBurden.trim() === "" ? Number.NaN : Number(payrollBurden);
  const validTarget = Number.isFinite(targetNumber) && targetNumber >= 0 && targetNumber <= 80;
  const validPayroll = Number.isFinite(payrollNumber) && payrollNumber >= 0 && payrollNumber <= 100;

  const scenario = useMemo(() => {
    if (!validTarget || !validPayroll) return [];
    const monthlyWagesCents = settings.pricing.business.monthlyWagesCents;
    const scenarioStaffCostCents =
      monthlyWagesCents === undefined
        ? settings.pricing.business.monthlyStaffCostCents
        : Math.round(monthlyWagesCents * (1 + payrollNumber / 100));
    const rows = buildPricingViewModel({
      items: settings.pricing.items,
      business: {
        ...settings.pricing.business,
        monthlyStaffCostCents: scenarioStaffCostCents,
        targetOperatingMargin: targetNumber / 100,
        payrollTaxRateStatus: "confirmed",
      },
    });
    const byId = new Map(settings.pricing.items.map((item) => [item.id, item]));
    return rows
      .map((row) => ({ row, item: byId.get(row.itemId) }))
      .filter(({ row, item }) => Boolean(item) && row.result.recommendedPriceCents !== null)
      .sort((left, right) => (right.item?.unitsSoldInWindow ?? 0) - (left.item?.unitsSoldInWindow ?? 0))
      .slice(0, 5);
  }, [settings.pricing, targetNumber, payrollNumber, validTarget, validPayroll]);

  const hasBusinessAdjustedScenario = scenario.some(({ row }) => row.result.calculationMode === "BUSINESS_ADJUSTED");

  function save() {
    setError(null);
    setSaved(false);
    if (!validTarget || !validPayroll) {
      setError(labels.invalid);
      return;
    }
    startTransition(async () => {
      const result = await saveOwnerEconomicsSettings({
        targetOperatingMarginPercent: targetNumber,
        payrollBurdenPercent: payrollNumber,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card-lg bg-card p-4">
          <span className="text-sm font-semibold text-ink-muted">{labels.currentMargin}</span>
          <div className="mt-1 font-headline text-3xl font-bold text-ink">
            {settings.currentOperatingMargin === null ? labels.currentMarginMissing : percentLabel(settings.currentOperatingMargin)}
          </div>
          {settings.currentOperatingMargin !== null && (
            <span className="mt-1 inline-flex rounded-full bg-paper px-2 py-1 text-xs font-bold text-ink-muted">
              {settings.currentMarginQuality === "actual" ? labels.actual : labels.estimated}
            </span>
          )}
        </div>

        <div className="rounded-card-lg bg-card p-4">
          <span className="text-sm font-semibold text-ink-muted">{labels.targetMargin}</span>
          <div className="mt-1 font-headline text-3xl font-bold text-good">
            {validTarget ? `${targetNumber}%` : "—"}
          </div>
          <span className="mt-1 inline-flex rounded-full bg-paper px-2 py-1 text-xs font-bold text-ink-muted">
            {settings.targetOperatingMarginStatus === "confirmed" ? labels.ownerConfirmed : labels.defaultAssumption}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          {labels.targetMargin}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={80}
              step="0.5"
              inputMode="decimal"
              value={targetMargin}
              onChange={(event) => setTargetMargin(event.target.value)}
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
            />
            <span className="font-bold text-ink-muted">%</span>
          </div>
          <span className="text-xs font-normal leading-snug text-ink-muted">{labels.targetMarginHint}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          {labels.payrollBurden}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              step="0.1"
              inputMode="decimal"
              value={payrollBurden}
              onChange={(event) => setPayrollBurden(event.target.value)}
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
            />
            <span className="font-bold text-ink-muted">%</span>
          </div>
          <span className="text-xs font-normal leading-snug text-ink-muted">{labels.payrollBurdenHint}</span>
          {settings.payrollTaxRateStatus === "estimated" && (
            <span className="mt-1 text-xs font-bold text-warn">{labels.payrollEstimated}</span>
          )}
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{labels.scenarioTitle}</h2>
          <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.scenarioHint}</p>
        </div>

        {!hasBusinessAdjustedScenario && (
          <p className="rounded-xl bg-paper p-3 text-sm leading-snug text-ink-muted">{labels.scenarioNoHistory}</p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-start text-xs font-bold text-ink-muted">
                <th className="py-2 pe-3 text-start">{labels.item}</th>
                <th className="px-2 py-2 text-end">{labels.productCost}</th>
                <th className="px-2 py-2 text-end">{labels.currentPrice}</th>
                <th className="px-2 py-2 text-end">{labels.suggestedPrice}</th>
                <th className="py-2 ps-2 text-end">{labels.change}</th>
              </tr>
            </thead>
            <tbody>
              {scenario.map(({ row, item }) => {
                if (!item || row.result.recommendedPriceCents === null) return null;
                const delta = row.result.recommendedPriceCents - item.currentPriceCents;
                return (
                  <tr key={row.itemId} className="border-b border-line last:border-0">
                    <td className="py-3 pe-3 font-bold text-ink">{item.name}</td>
                    <td className="px-2 py-3 text-end text-ink-muted">{formatCents(item.productCostCents)}</td>
                    <td className="px-2 py-3 text-end text-ink">{formatCents(item.currentPriceCents)}</td>
                    <td className="px-2 py-3 text-end font-bold text-good">{formatCents(row.result.recommendedPriceCents)}</td>
                    <td className="py-3 ps-2 text-end font-semibold text-ink">
                      {delta === 0 ? "—" : `${delta > 0 ? "+" : "-"}${formatCents(Math.abs(delta))}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {error && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {saved && <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{labels.saved}</p>}

      <button
        type="button"
        onClick={save}
        disabled={isPending || !validTarget || !validPayroll}
        className="min-h-14 rounded-full bg-ink px-5 text-base font-bold text-paper disabled:opacity-40"
      >
        {isPending ? labels.saving : labels.save}
      </button>
    </div>
  );
}
