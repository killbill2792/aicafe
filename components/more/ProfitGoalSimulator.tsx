"use client";

import { useMemo, useState } from "react";
import { formatCents } from "@/lib/calc";
import { simulateProfitGoal } from "@/lib/calc/profitGoalSimulator";
import type { ProfitGoalSimulatorData } from "@/lib/data/getProfitGoalSimulatorData";

type Labels = {
  currentMargin: string;
  currentMarginMissing: string;
  actual: string;
  estimated: string;
  targetMargin: string;
  targetMarginHint: string;
  run: string;
  simulationOnly: string;
  assumption: string;
  readyMeetsTarget: string;
  readyNeedsIncrease: string;
  largeChange: string;
  unavailableSales: string;
  unavailableFees: string;
  unavailableCosts: string;
  targetTested: string;
  item: string;
  productCost: string;
  productCostPct: string;
  currentPrice: string;
  simulatedPrice: string;
  change: string;
  unavailableItem: string;
  invalid: string;
  targetNotFeasible: string;
};

function pct(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

export default function ProfitGoalSimulator({
  data,
  labels,
}: {
  data: ProfitGoalSimulatorData;
  labels: Labels;
}) {
  const [draftTarget, setDraftTarget] = useState("15");
  const [target, setTarget] = useState<number | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const simulation = useMemo(() => {
    if (!data.economics || !data.canSimulate || target === null) return null;
    return simulateProfitGoal({
      economics: data.economics,
      targetOperatingMargin: target / 100,
      items: data.items,
    });
  }, [data, target]);

  function run() {
    setError(null);
    const parsed = draftTarget.trim() === "" ? Number.NaN : Number(draftTarget);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 80) {
      setError(labels.invalid);
      return;
    }
    setTarget(parsed);
    setHasRun(true);
  }

  const unavailableText =
    data.unavailableReason === "NOT_ENOUGH_SALES"
      ? labels.unavailableSales
      : data.unavailableReason === "MISSING_PROCESSING_FEES"
        ? labels.unavailableFees
        : data.unavailableReason === "MISSING_PRODUCT_COSTS"
          ? labels.unavailableCosts
          : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card-lg bg-good-tint p-4 text-sm leading-snug text-ink">
        <strong className="block text-base">{labels.simulationOnly}</strong>
        <span className="mt-1 block">{labels.assumption}</span>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card-lg bg-card p-4">
          <span className="text-sm font-semibold text-ink-muted">{labels.currentMargin}</span>
          <div className="mt-1 font-headline text-3xl font-bold text-ink">
            {data.currentOperatingMargin === null ? labels.currentMarginMissing : pct(data.currentOperatingMargin)}
          </div>
          {data.currentOperatingMargin !== null && (
            <span className="mt-1 inline-flex rounded-full bg-paper px-2 py-1 text-xs font-bold text-ink-muted">
              {data.currentMarginQuality === "estimated" ? labels.estimated : labels.actual}
            </span>
          )}
        </div>

        <div className="rounded-card-lg bg-card p-4">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            {labels.targetMargin}
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={80}
                step="0.5"
                inputMode="decimal"
                value={draftTarget}
                onChange={(event) => setDraftTarget(event.target.value)}
                className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
              />
              <span className="font-bold text-ink-muted">%</span>
            </div>
            <span className="text-xs font-normal leading-snug text-ink-muted">{labels.targetMarginHint}</span>
          </label>
          <button
            type="button"
            onClick={run}
            className="mt-3 min-h-11 rounded-full bg-ink px-5 text-sm font-bold text-paper"
          >
            {labels.run}
          </button>
        </div>
      </section>

      {error && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {unavailableText && <p className="rounded-xl bg-paper p-4 text-sm leading-snug text-ink-muted">{unavailableText}</p>}
      {hasRun && data.canSimulate && target !== null && (
        <p className="sr-only" aria-live="polite">{labels.targetTested.replace("{target}", `${target}%`)}</p>
      )}

      {simulation?.kind === "unavailable" && (
        <p className="rounded-xl bg-warn-tint p-4 text-sm font-semibold leading-snug text-warn">
          {labels.targetNotFeasible}
        </p>
      )}

      {simulation?.kind === "ready" && (
        <>
          <section className="rounded-card-lg bg-card p-4">
            <span className="text-sm font-semibold text-ink-muted">{labels.targetTested.replace("{target}", `${target}%`)}</span>
            <p className="mt-2 text-base font-bold leading-snug text-ink">
              {simulation.revenueMultiplier <= 1.000001
                ? labels.readyMeetsTarget
                : labels.readyNeedsIncrease
                    .replace("{target}", `${target}%`)
                    .replace("{increase}", `${simulation.requiredPriceIncreasePercent.toFixed(1)}%`)}
            </p>
            {simulation.largeChange && (
              <p className="mt-2 rounded-xl bg-warn-tint p-3 text-sm font-semibold leading-snug text-warn">
                {labels.largeChange}
              </p>
            )}
          </section>

          <section className="rounded-card-lg bg-card p-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-xs font-bold text-ink-muted">
                    <th className="py-2 pe-3 text-start">{labels.item}</th>
                    <th className="px-2 py-2 text-end">{labels.productCost}</th>
                    <th className="px-2 py-2 text-end">{labels.productCostPct}</th>
                    <th className="px-2 py-2 text-end">{labels.currentPrice}</th>
                    <th className="px-2 py-2 text-end">{labels.simulatedPrice}</th>
                    <th className="py-2 ps-2 text-end">{labels.change}</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.items.map((item) => (
                    <tr key={item.id} className="border-b border-line last:border-0">
                      <td className="py-3 pe-3 font-bold text-ink">{item.name}</td>
                      <td className="px-2 py-3 text-end text-ink-muted">
                        {item.productCostCents === null ? "—" : formatCents(item.productCostCents)}
                      </td>
                      <td className="px-2 py-3 text-end text-ink-muted">
                        {item.productCostPercent === null ? "—" : pct(item.productCostPercent)}
                      </td>
                      <td className="px-2 py-3 text-end text-ink">{formatCents(item.currentPriceCents)}</td>
                      <td className="px-2 py-3 text-end font-bold text-good">
                        {item.simulatedPriceCents === null ? labels.unavailableItem : formatCents(item.simulatedPriceCents)}
                      </td>
                      <td className="py-3 ps-2 text-end font-semibold text-ink">
                        {item.changeCents === null || item.changeCents === 0 ? "—" : `+${formatCents(item.changeCents)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
