"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatCents, roundHalfUpToCent, scenarioDelayDays, scenarioExtraCostCents } from "@/lib/calc";
import type { ScenarioItem } from "@/lib/viewmodels/scenarioViewModel";

// Round to a whole cent before dividing — dividing a fractional-cent value (e.g. 1.5) straight
// into toFixed(2) hits a classic floating-point snag (0.015.toFixed(2) is "0.01", not "0.02" —
// 0.015 isn't exactly representable in binary), which would prefill this input with a different
// number than the matching dropdown label (formatCents rounds first, same as this now does).
function costInput(cents: number): string {
  return (roundHalfUpToCent(cents) / 100).toFixed(2);
}

export default function TryScenario({ items, avgDailyContributionCents }: { items: ScenarioItem[]; avgDailyContributionCents: number }) {
  const t = useTranslations("Scenario");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  // Starts at the picked drink's own current ingredient cost — a $0 change — rather than $0.00,
  // which used to make the calculator show "you'd save money" before anyone had touched anything
  // and look broken/pointless. Type a different number to see an actual scenario.
  const [priceInput, setPriceInput] = useState(costInput(items[0]?.ingredientsCentsToday ?? 0));
  const [days, setDays] = useState(7);

  const item = items.find((i) => i.id === itemId) ?? items[0];
  const newPriceCents = Math.round((Number(priceInput) || 0) * 100);

  function handlePickItem(id: string) {
    setItemId(id);
    const picked = items.find((i) => i.id === id);
    if (picked) setPriceInput(costInput(picked.ingredientsCentsToday));
  }

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
      <p className="text-[15px] leading-snug text-ink-muted">{t("explainer")}</p>

      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-semibold">{t("pickDrink")}</span>
        <select
          value={item.id}
          onChange={(e) => handlePickItem(e.target.value)}
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

      {item.avgDrinksPerDay === 0 ? (
        // extraCostCents is always 0 with no sales history to multiply a per-drink delta by —
        // showing that as "no change" would look identical to the calculator being broken no
        // matter what's typed. Say why instead of a silently-misleading $0.00.
        <div className="flex flex-col gap-2 rounded-2xl bg-[#FAF6F0] p-4">
          <p className="text-[15px] leading-snug text-ink-muted">{t("noSalesDataForItem", { name: item.name })}</p>
        </div>
      ) : (
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
      )}
    </div>
  );
}
