"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents, scenarioDelayDays, scenarioExtraCostCents } from "@/lib/calc";
import type { ScenarioItem } from "@/lib/viewmodels/scenarioViewModel";

export default function TryScenario({ items, avgDailyContributionCents }: { items: ScenarioItem[]; avgDailyContributionCents: number }) {
  const t = useTranslations("Scenario");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [priceInput, setPriceInput] = useState("0.00");
  const [days, setDays] = useState(7);

  const item = items.find((i) => i.id === itemId) ?? items[0];
  const newPriceCents = Math.round((Number(priceInput) || 0) * 100);

  const result = useMemo(() => {
    if (!item) return null;
    const deltaCentsPerDrink = newPriceCents - item.ingredientsCentsToday;
    const extraCostCents = scenarioExtraCostCents(deltaCentsPerDrink, item.avgDrinksPerDay, days);
    const delayDays = scenarioDelayDays(extraCostCents, avgDailyContributionCents);
    return { deltaCentsPerDrink, extraCostCents, delayDays };
  }, [item, newPriceCents, days, avgDailyContributionCents]);

  if (!item || !result) {
    return <p className="text-[15px] text-ink-muted">{t("noItems")}</p>;
  }

  const costs = result.extraCostCents > 0;
  const saves = result.extraCostCents < 0;

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-semibold">{t("pickDrink")}</span>
        <select
          value={item.id}
          onChange={(e) => setItemId(e.target.value)}
          className="h-12 w-full min-w-0 rounded-xl border border-line bg-card px-3 text-base"
        >
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {t("currentIngredients", { amount: formatCents(i.ingredientsCentsToday) })}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-semibold">{t("newIngredientCost")}</span>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-ink-muted">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            className="h-12 w-28 rounded-xl border border-line bg-card px-3 text-base"
          />
          <button
            type="button"
            onClick={() => setPriceInput("0.00")}
            className="h-12 rounded-xl bg-[#FAF6F0] px-3 text-sm font-semibold text-ink-muted"
          >
            {t("makeFree")}
          </button>
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-semibold">{t("forHowManyDays")}</span>
        <input
          type="number"
          inputMode="numeric"
          min="1"
          max="90"
          value={days}
          onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
          className="h-12 w-28 rounded-xl border border-line bg-card px-3 text-base"
        />
      </label>

      <div className={`flex flex-col gap-2 rounded-2xl p-4 ${costs ? "bg-warn-tint" : saves ? "bg-good-tint" : "bg-[#FAF6F0]"}`}>
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold">{t("totalImpact", { days })}</span>
          <span className={`text-xl font-bold ${costs ? "text-warn" : saves ? "text-good" : "text-ink"}`}>
            {result.extraCostCents === 0 ? formatCents(0) : formatCents(Math.abs(result.extraCostCents))}
            {costs ? ` ${t("moreCost")}` : saves ? ` ${t("saved")}` : ""}
          </span>
        </div>
        <p className="text-[15px] leading-snug text-ink-muted">
          {result.extraCostCents === 0
            ? t("noChangeNote")
            : Number.isFinite(result.delayDays)
              ? t(costs ? "delaysRecovery" : "speedsUpRecovery", { days: Math.abs(result.delayDays).toFixed(1) })
              : t("delayUnknown")}
        </p>
      </div>
    </div>
  );
}
