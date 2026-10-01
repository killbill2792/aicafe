"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { addRecipeLine, deleteRecipeLine } from "@/lib/actions/menuItems";
import { formatCents, type PricingResult } from "@/lib/calc";
import { needsIngredientConversion, recipeDisplayUnitsFor, type IngredientUnitConversion, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import MissingPriceForm from "./MissingPriceForm";

const UNIT_LABEL_KEYS: Record<RecipeDisplayUnit, string> = {
  g: "recipeUnitG", ml: "recipeUnitMl", fl_oz: "recipeUnitFlOz", each: "recipeUnitEach", shot: "recipeUnitShot", pump: "recipeUnitPump",
};

export default function RecipeEditor({
  item,
  ingredients,
  ingredientConversions,
  pricingResult,
}: {
  item: MenuItemForEdit;
  ingredients: IngredientOption[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>;
  pricingResult?: PricingResult;
}) {
  const t = useTranslations("ManageMenu");
  const unitLabel = (unit: RecipeDisplayUnit | "g" | "ml" | "each") => t(UNIT_LABEL_KEYS[unit as RecipeDisplayUnit] ?? "recipeUnitG");

  const [ingredientId, setIngredientId] = useState("");
  const [newName, setNewName] = useState("");
  const [newBaseUnit, setNewBaseUnit] = useState<"g" | "ml" | "each">("g");
  const [displayUnit, setDisplayUnit] = useState<RecipeDisplayUnit>("g");
  const [quantity, setQuantity] = useState("");
  const [conversionValue, setConversionValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState(false);

  const selectedIngredient = ingredients.find((i) => i.id === ingredientId);
  const effectiveBaseUnit = selectedIngredient?.baseUnit ?? newBaseUnit;
  const unitOptions = useMemo(() => recipeDisplayUnitsFor(effectiveBaseUnit), [effectiveBaseUnit]);
  const hasExistingConversion = selectedIngredient ? (ingredientConversions[selectedIngredient.id] ?? []).some((c) => c.unit === displayUnit) : false;
  const needsConversionInput = needsIngredientConversion(displayUnit) && !hasExistingConversion;

  // Switching ingredients (or the new-ingredient's base unit) can make the currently-selected
  // café-friendly unit invalid for the new base unit (e.g. "fl oz" was selected, then the owner
  // picks a gram-based ingredient). Reset it right in the handler that causes the change, rather
  // than reacting to it afterward in an effect — a stale g/ml/fl oz selection must never reach the
  // server, which now rejects it (see toBaseUnitQuantity).
  function resetDisplayUnitFor(baseUnit: "g" | "ml" | "each") {
    const options = recipeDisplayUnitsFor(baseUnit);
    setDisplayUnit((current) => (options.includes(current) ? current : options[0]));
    setConversionValue("");
  }

  function handleAddLine() {
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    if (!ingredientId && !newName.trim()) return;
    if (needsConversionInput && !(Number(conversionValue) > 0)) return;
    setError(null);
    setJustAdded(false);
    startTransition(async () => {
      const result = await addRecipeLine({
        menuItemId: item.id,
        ingredientId: ingredientId || undefined,
        newIngredientName: ingredientId ? undefined : newName.trim(),
        newIngredientUnit: ingredientId ? undefined : newBaseUnit,
        displayUnit,
        displayQuantity: qty,
        newConversionBaseUnitsPerUnit: needsConversionInput ? Number(conversionValue) : undefined,
      });
      if (result.ok) {
        setQuantity("");
        setNewName("");
        setIngredientId("");
        setConversionValue("");
        setJustAdded(true);
      } else {
        setError(result.error);
      }
    });
  }

  function handleRemoveLine(ingId: string) {
    setError(null);
    startTransition(async () => {
      // A failed delete must surface, not just vanish — otherwise the owner has no way to know
      // the ingredient is still really on the recipe.
      const result = await deleteRecipeLine(item.id, ingId);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-bold">{t("recipe")}</span>
        <span className="text-xs text-ink-muted">{t("recipeHint")}</span>
      </div>

      {item.recipe.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("noIngredientsYet")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted">
                <th scope="col" className="min-w-0 pb-1 pr-2 font-semibold">{t("ingredientColumnLabel")}</th>
                <th scope="col" className="pb-1 pr-2 text-right font-semibold">{t("amountColumnLabel")}</th>
                <th scope="col" className="w-8 pb-1"><span className="sr-only">{t("remove")}</span></th>
              </tr>
            </thead>
            <tbody>
              {item.recipe.map((line) => (
                <tr key={line.ingredientId} className="border-t border-[#EFE7DB] align-top">
                  <td className="min-w-0 max-w-0 truncate py-1.5 pr-2">{line.ingredientName}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right text-ink-muted">
                    {line.displayQuantity ?? line.quantity} {line.displayUnit ? unitLabel(line.displayUnit as RecipeDisplayUnit) : line.baseUnit}
                  </td>
                  <td className="py-1.5 text-right">
                    <button type="button" onClick={() => handleRemoveLine(line.ingredientId)} disabled={isPending} aria-label={t("remove")} className="text-warn">
                      <Trash2 aria-hidden="true" size={16} />
                    </button>
                  </td>
                  {line.costCents === null && <td className="py-1.5" colSpan={3}><MissingPriceForm line={line} labels={{ ingredientCostLabel: t("ingredientCostLabel"), ingredientCostForLabel: t("ingredientCostForLabel"), add: t("add") }} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pricingResult && pricingResult.status === "PRICE_UNAVAILABLE" && (
        <div className="rounded-xl bg-warn-tint px-3 py-2.5">
          <span className="text-sm font-semibold text-warn">{t("pricingStatusUnavailable")}</span>
        </div>
      )}
      {pricingResult && pricingResult.status !== "PRICE_UNAVAILABLE" && pricingResult.recommendedPriceCents !== null && (
        <div className="flex flex-col gap-0.5 rounded-xl bg-good-tint px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-good">
              {{ NEW_PRICE: t("pricingStatusNew"), KEEP_CURRENT_PRICE: t("pricingStatusKeep"), REVIEW_PRICE: t("pricingStatusReview") }[pricingResult.status as "NEW_PRICE" | "KEEP_CURRENT_PRICE" | "REVIEW_PRICE"]}
            </span>
            <span className="text-base font-bold text-good">{formatCents(pricingResult.recommendedPriceCents)}</span>
          </div>
          <span className="text-xs text-good">
            {{ BENCHMARK_EXPLAINER: t("pricingExplainerBenchmark"), BUSINESS_ADJUSTED_EXPLAINER: t("pricingExplainerBusinessAdjusted"), INCOMPLETE_DATA_EXPLAINER: t("pricingExplainerIncomplete") }[pricingResult.explanationCode]}
          </span>
          {pricingResult.warnings.map((warning) => (
            <span key={warning} className="text-xs font-semibold text-warn">
              {{
                BUSINESS_ADJUSTMENT_CAPPED: t("pricingWarningCapped"),
                CATEGORY_PRICE_OUTLIER: t("pricingWarningCategoryOutlier"),
                CATEGORY_COST_PERCENT_OUTLIER: t("pricingWarningCostOutlier"),
                INCOMPLETE_RECIPE: t("pricingWarningIncompleteRecipe"),
                LOW_SAMPLE_SIZE: t("pricingWarningLowSample"),
              }[warning]}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-[#EFE7DB] pt-3">
        <select
          value={ingredientId}
          onChange={(e) => {
            const newIngredientId = e.target.value;
            setIngredientId(newIngredientId);
            const nextBaseUnit = ingredients.find((i) => i.id === newIngredientId)?.baseUnit ?? newBaseUnit;
            resetDisplayUnitFor(nextBaseUnit);
          }}
          className="h-11 w-full min-w-0 rounded-lg border border-line bg-card px-2.5 text-sm text-ink"
        >
          <option value="">{t("newIngredient")}</option>
          {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.baseUnit})</option>)}
        </select>
        {!ingredientId && (
          <div className="flex min-w-0 gap-2">
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("ingredientLabel")} className="h-11 w-full min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm text-ink" />
            <select
              value={newBaseUnit}
              onChange={(e) => {
                const unit = e.target.value as "g" | "ml" | "each";
                setNewBaseUnit(unit);
                resetDisplayUnitFor(unit);
              }}
              className="h-11 w-28 min-w-0 shrink-0 rounded-lg border border-line px-1 text-sm text-ink"
            >
              <option value="g">{t("unitG")}</option>
              <option value="ml">{t("unitMl")}</option>
              <option value="each">{t("unitEach")}</option>
            </select>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <input type="number" inputMode="decimal" min="0" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={t("quantityLabel")} className="h-11 w-full min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm text-ink" />
          <select value={displayUnit} onChange={(e) => { setDisplayUnit(e.target.value as RecipeDisplayUnit); setConversionValue(""); }} className="h-11 w-24 min-w-0 shrink-0 rounded-lg border border-line px-1 text-sm text-ink">
            {unitOptions.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
          </select>
        </div>
        {needsConversionInput && (
          <div className="flex min-w-0 items-center gap-2 rounded-lg bg-[#FAF6F0] p-2 text-sm">
            <span className="min-w-0 flex-1">{t("defineUnitConversion", { unit: unitLabel(displayUnit), baseUnit: effectiveBaseUnit })}</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={conversionValue} onChange={(e) => setConversionValue(e.target.value)} className="h-10 w-20 shrink-0 rounded-lg border border-line px-2 text-ink" />
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={handleAddLine} disabled={isPending || !quantity || (needsConversionInput && !conversionValue)} className="h-11 shrink-0 rounded-full bg-ink px-4 text-sm font-bold text-paper disabled:opacity-40">
            {t("addIngredient")}
          </button>
        </div>
        {error && <p className="text-sm text-warn">{error}</p>}
        {justAdded && !error && <p className="text-sm font-semibold text-good">{t("ingredientAdded")}</p>}
      </div>
    </div>
  );
}
