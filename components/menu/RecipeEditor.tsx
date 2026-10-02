"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2, Package, Search, ChevronLeft } from "lucide-react";
import { addRecipeLine, deleteRecipeLine, updateRecipeLine } from "@/lib/actions/menuItems";
import { useRouter } from "@/i18n/navigation";
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
}: {
  item: MenuItemForEdit;
  ingredients: IngredientOption[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>;
}) {
  const t = useTranslations("ManageMenu");
  const router = useRouter();
  const unitLabel = (unit: RecipeDisplayUnit | "g" | "ml" | "each") => t(UNIT_LABEL_KEYS[unit as RecipeDisplayUnit] ?? "recipeUnitG");

  const [ingredientId, setIngredientId] = useState("");
  // Explicit, owner-driven: only tapping "+ New ingredient" enters new-ingredient mode, and only
  // the explicit "back to search" control leaves it. Typing in the search box must never flip
  // this — it used to be inferred from "no ingredient selected yet", which made the new-ingredient
  // fields appear the instant the owner started typing a search, defeating the existing-first flow.
  const [addingNew, setAddingNew] = useState(false);
  const [ingredientFilter, setIngredientFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [newBaseUnit, setNewBaseUnit] = useState<"g" | "ml" | "each">("g");
  const [displayUnit, setDisplayUnit] = useState<RecipeDisplayUnit>("g");
  const [quantity, setQuantity] = useState("");
  const [conversionValue, setConversionValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState(false);
  const [editing, setEditing] = useState(false);
  const initialDrafts = () => Object.fromEntries(item.recipe.map((line) => [line.ingredientId, { quantity: String(line.displayQuantity ?? line.quantity), unit: (line.displayUnit ?? line.baseUnit) as RecipeDisplayUnit }]));
  const [drafts, setDrafts] = useState<Record<string, { quantity: string; unit: RecipeDisplayUnit }>>(initialDrafts);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());

  const mode: "search" | "existing" | "new" = addingNew ? "new" : ingredientId ? "existing" : "search";
  const selectedIngredient = ingredients.find((i) => i.id === ingredientId);
  const effectiveBaseUnit = selectedIngredient?.baseUnit ?? newBaseUnit;
  const unitOptions = useMemo(() => recipeDisplayUnitsFor(effectiveBaseUnit), [effectiveBaseUnit]);
  const hasExistingConversion = selectedIngredient ? (ingredientConversions[selectedIngredient.id] ?? []).some((c) => c.unit === displayUnit) : false;
  const needsConversionInput = needsIngredientConversion(displayUnit) && !hasExistingConversion;
  const filteredIngredients = useMemo(
    () => ingredients.filter((i) => i.name.toLocaleLowerCase().includes(ingredientFilter.trim().toLocaleLowerCase())),
    [ingredients, ingredientFilter],
  );

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

  function selectExistingIngredient(ingredient: IngredientOption) {
    setIngredientId(ingredient.id);
    setAddingNew(false);
    resetDisplayUnitFor(ingredient.baseUnit);
  }

  function startNewIngredient() {
    setAddingNew(true);
    setIngredientId("");
    resetDisplayUnitFor(newBaseUnit);
  }

  // The explicit way back from either "existing selected" or "new ingredient" to the default
  // search state — abandons whatever was picked/typed in that state, same as never having opened it.
  function returnToSearch() {
    setAddingNew(false);
    setIngredientId("");
    setNewName("");
    setNewBaseUnit("g");
    resetDisplayUnitFor("g");
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
        setAddingNew(false);
        setConversionValue("");
        setJustAdded(true);
      } else {
        setError(result.error);
      }
    });
  }

  function handleRemoveLine(ingId: string) {
    setRemoved((current) => new Set(current).add(ingId));
  }

  function cancelEditing() {
    setDrafts(initialDrafts()); setRemoved(new Set()); setEditing(false); setError(null);
  }

  function saveRecipe() {
    setError(null);
    startTransition(async () => {
      for (const line of item.recipe) {
        if (removed.has(line.ingredientId)) {
          const result = await deleteRecipeLine(item.id, line.ingredientId);
          if (!result.ok) { setError(result.error); return; }
          continue;
        }
        const draft = drafts[line.ingredientId];
        const result = await updateRecipeLine({ menuItemId: item.id, ingredientId: line.ingredientId, displayUnit: draft.unit, displayQuantity: Number(draft.quantity) });
        if (!result.ok) { setError(result.error); return; }
      }
      setEditing(false); setRemoved(new Set()); router.refresh();
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
        <ul className="flex flex-col gap-2">
          {item.recipe.filter((line) => !removed.has(line.ingredientId)).map((line) => (
            <li key={line.ingredientId} className="flex flex-wrap items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#FAF6F0] text-ink-muted">
                <Package aria-hidden="true" size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{line.ingredientName}</span>
              {editing ? <><input aria-label={`${line.ingredientName} ${t("quantityLabel")}`} type="number" min="0.01" step="0.01" value={drafts[line.ingredientId].quantity} onChange={(event) => setDrafts((current) => ({ ...current, [line.ingredientId]: { ...current[line.ingredientId], quantity: event.target.value } }))} className="h-12 w-20 rounded-lg border border-line px-2" /><select aria-label={`${line.ingredientName} unit`} value={drafts[line.ingredientId].unit} onChange={(event) => setDrafts((current) => ({ ...current, [line.ingredientId]: { ...current[line.ingredientId], unit: event.target.value as RecipeDisplayUnit } }))} className="h-12 rounded-lg border border-line px-2">{recipeDisplayUnitsFor(line.baseUnit).map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}</select></> : <span className="shrink-0 text-[15px] text-ink-muted">{line.displayQuantity ?? line.quantity} {line.displayUnit ? unitLabel(line.displayUnit as RecipeDisplayUnit) : line.baseUnit}</span>}
              {editing && <button type="button" onClick={() => handleRemoveLine(line.ingredientId)} disabled={isPending} aria-label={t("remove")} className="flex min-h-12 min-w-12 shrink-0 items-center justify-center text-warn">
                <Trash2 aria-hidden="true" size={16} />
              </button>}
              {line.costCents === null && (
                <div className="w-full basis-full"><MissingPriceForm line={line} labels={{ ingredientCostLabel: t("ingredientCostLabel"), ingredientCostForLabel: t("ingredientCostForLabel"), add: t("add") }} /></div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!editing && <button type="button" onClick={() => setEditing(true)} className="min-h-12 w-fit rounded-full border border-line px-4 font-bold text-ink">{t("editRecipe")}</button>}
      {editing && <div className="flex flex-col gap-2 border-t border-[#EFE7DB] pt-3">
        <span className="text-sm font-bold">{t("addIngredient")}</span>

        {mode === "search" && (
          <>
            <label className="flex min-h-11 items-center gap-2 rounded-lg border border-line bg-card px-2.5 text-ink-muted">
              <Search aria-hidden="true" size={16} />
              <span className="sr-only">{t("ingredientSearchLabel")}</span>
              <input
                value={ingredientFilter}
                onChange={(e) => setIngredientFilter(e.target.value)}
                placeholder={t("ingredientSearchLabel")}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
              />
            </label>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-line p-1.5">
              {filteredIngredients.length === 0 && <p className="px-2 py-2 text-sm text-ink-muted">{t("noMatchingIngredients")}</p>}
              {filteredIngredients.map((i) => (
                <button key={i.id} type="button" onClick={() => selectExistingIngredient(i)} className="flex min-h-12 items-center justify-between rounded-lg px-2.5 text-left text-sm text-ink">
                  <span className="truncate">{i.name}</span>
                  <span className="shrink-0 text-xs text-ink-muted">{t("existingTag")}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={startNewIngredient} className="w-fit text-sm font-semibold text-ink-muted">
              {t("newIngredient")}
            </button>
          </>
        )}

        {mode === "existing" && selectedIngredient && (
          <div className="flex min-h-10 items-center justify-between rounded-lg bg-good-tint px-2.5 text-sm font-semibold text-good">
            <span className="truncate">{selectedIngredient.name}</span>
            <button type="button" onClick={returnToSearch} className="shrink-0 text-xs font-semibold text-good underline">
              {t("change")}
            </button>
          </div>
        )}

        {mode === "new" && (
          <>
            <button type="button" onClick={returnToSearch} className="flex w-fit items-center gap-1 text-sm font-semibold text-ink-muted">
              <ChevronLeft aria-hidden="true" size={16} /> {t("chooseExisting")}
            </button>
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
          </>
        )}

        {mode !== "search" && (
          <>
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
          </>
        )}

        {error && <p className="text-sm text-warn">{error}</p>}
        {justAdded && !error && <p className="text-sm font-semibold text-good">{t("ingredientAdded")}</p>}
        <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={cancelEditing} className="min-h-12 rounded-full border border-line font-semibold text-ink-muted">{t("cancel")}</button><button type="button" onClick={saveRecipe} disabled={isPending} className="min-h-12 rounded-full bg-ink font-bold text-paper disabled:opacity-40">{t("done")}</button></div>
      </div>}
    </div>
  );
}
