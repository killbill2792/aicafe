"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import { addRecipeLine, deleteRecipeLine, updateRecipeLine } from "@/lib/actions/menuItems";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import type { BaseUnit, IngredientUnitConversion, RecipeDisplayUnit } from "@/lib/calc/recipeUnits";
import { recipeDisplayUnitsFor, toBaseUnitQuantity } from "@/lib/calc/recipeUnits";
import { useRouter } from "@/i18n/navigation";

type Draft = { quantity: string; unit: RecipeDisplayUnit; removed?: boolean };
type NewRow = {
  key: string;
  ingredient: IngredientOption | null;
  name: string;
  baseUnit: BaseUnit;
  purchaseCost: string;
  purchaseQuantity: string;
  purchaseUnit: RecipeDisplayUnit;
  amounts: Record<string, Draft>;
};

const draftForLine = (line: MenuItemForEdit["recipe"][number]): Draft => ({
  quantity: String(line.displayQuantity ?? line.quantity),
  unit: (line.displayUnit ?? line.baseUnit) as RecipeDisplayUnit,
});
const draftsFromItems = (items: MenuItemForEdit[]) => Object.fromEntries(
  items.flatMap((item) => item.recipe.map((line) => [`${item.id}:${line.ingredientId}`, draftForLine(line)])),
);

export default function RecipeMatrix({ items, ingredients, ingredientConversions, focusedSizeId, labels }: {
  items: MenuItemForEdit[];
  ingredients: IngredientOption[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>;
  focusedSizeId?: string;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => draftsFromItems(items));
  const [newRow, setNewRow] = useState<NewRow | null>(null);
  const [ingredientOpen, setIngredientOpen] = useState(false);

  const rows = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => item.recipe.forEach((line) => map.set(line.ingredientId, line.ingredientName)));
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const query = newRow?.name.trim().toLocaleLowerCase() ?? "";
  const usedIds = new Set(rows.map(([id]) => id));
  const suggestions = ingredientOpen && query
    ? ingredients.filter((ingredient) => !usedIds.has(ingredient.id) && ingredient.name.toLocaleLowerCase().includes(query)).slice(0, 6)
    : [];
  const exactIngredient = query ? ingredients.find((ingredient) => ingredient.name.toLocaleLowerCase() === query) ?? null : null;

  function beginRow() {
    setNewRow({ key: `new:${Date.now()}`, ingredient: null, name: "", baseUnit: "g", purchaseCost: "", purchaseQuantity: "", purchaseUnit: "g", amounts: {} });
    setIngredientOpen(true);
    setSaved(false);
  }
  function setBaseUnit(baseUnit: BaseUnit) {
    if (!newRow) return;
    setNewRow({ ...newRow, ingredient: null, baseUnit, purchaseUnit: baseUnit, amounts: Object.fromEntries(items.map((item) => [item.id, { quantity: newRow.amounts[item.id]?.quantity ?? "", unit: baseUnit }])) });
  }
  function chooseIngredient(ingredient: IngredientOption) {
    if (!newRow) return;
    const firstUnit = recipeDisplayUnitsFor(ingredient.baseUnit, ingredientConversions[ingredient.id] ?? [])[0];
    setNewRow({ ...newRow, ingredient, name: ingredient.name, baseUnit: ingredient.baseUnit, purchaseCost: "", purchaseQuantity: "", purchaseUnit: firstUnit, amounts: Object.fromEntries(items.map((item) => [item.id, { quantity: newRow.amounts[item.id]?.quantity ?? "", unit: firstUnit }])) });
    setIngredientOpen(false);
  }
  function updateIngredientName(name: string) {
    const exact = ingredients.find((ingredient) => ingredient.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    if (exact) { chooseIngredient(exact); return; }
    if (newRow) setNewRow({ ...newRow, ingredient: null, name });
  }
  function reset() {
    setDrafts(draftsFromItems(items));
    setNewRow(null);
    setIngredientOpen(false);
    setError(null);
    setSaved(false);
  }
  function save() {
    const additions = newRow ? items.flatMap((item) => {
      const amount = newRow.amounts[item.id];
      return Number(amount?.quantity) > 0 ? [{ item, amount }] : [];
    }) : [];
    if (newRow && ((!newRow.ingredient && !newRow.name.trim()) || additions.length === 0)) {
      setError(labels.completeDraft);
      return;
    }
    const resolvedIngredient = newRow?.ingredient ?? exactIngredient;
    const hasPurchaseCost = Boolean(newRow && !resolvedIngredient && (newRow.purchaseCost || newRow.purchaseQuantity));
    const purchaseBaseQuantity = newRow && !resolvedIngredient
      ? toBaseUnitQuantity(newRow.purchaseUnit, Number(newRow.purchaseQuantity), newRow.baseUnit)
      : null;
    const purchaseCostCents = newRow ? Math.round(Number(newRow.purchaseCost) * 100) : 0;
    if (hasPurchaseCost && (!(purchaseCostCents > 0) || purchaseBaseQuantity === null)) {
      setError(labels.completePurchaseCost);
      return;
    }
    const existingRowAdditions = rows.flatMap(([ingredientId]) => items.flatMap((item) => {
      if (item.recipe.some((line) => line.ingredientId === ingredientId)) return [];
      const amount = drafts[`${item.id}:${ingredientId}`];
      return Number(amount?.quantity) > 0 ? [{ ingredientId, item, amount }] : [];
    }));
    setError(null);
    setSaved(false);
    start(async () => {
      let completed = 0;
      const total = items.reduce((count, item) => count + item.recipe.length, 0) + existingRowAdditions.length + additions.length;
      for (const item of items) for (const line of item.recipe) {
        const draft = drafts[`${item.id}:${line.ingredientId}`];
        if (!draft) continue;
        const result = draft.removed
          ? await deleteRecipeLine(item.id, line.ingredientId)
          : await updateRecipeLine({ menuItemId: item.id, ingredientId: line.ingredientId, displayUnit: draft.unit, displayQuantity: Number(draft.quantity) });
        if (!result.ok) { setError(completed ? labels.partialSave : result.error); return; }
        completed += 1;
      }
      for (const { ingredientId, item, amount } of existingRowAdditions) {
        const result = await addRecipeLine({ menuItemId: item.id, ingredientId, displayUnit: amount.unit, displayQuantity: Number(amount.quantity) });
        if (!result.ok) { setError(completed ? labels.partialSave : result.error); return; }
        completed += 1;
      }
      for (const [index, { item, amount }] of additions.entries()) {
        const result = await addRecipeLine({
          menuItemId: item.id,
          ingredientId: resolvedIngredient?.id,
          newIngredientName: resolvedIngredient ? undefined : newRow?.name.trim(),
          newIngredientUnit: resolvedIngredient ? undefined : newRow?.baseUnit,
          newIngredientCostCents: index === 0 && hasPurchaseCost ? purchaseCostCents : undefined,
          newIngredientCostQuantity: index === 0 && hasPurchaseCost ? purchaseBaseQuantity! : undefined,
          displayUnit: amount.unit,
          displayQuantity: Number(amount.quantity),
        });
        if (!result.ok) { setError(completed ? labels.partialSave : result.error); return; }
        completed += 1;
      }
      setSaved(total > 0);
      router.refresh();
    });
  }

  function amountCell(row: NewRow, item: MenuItemForEdit) {
    const draft = row.amounts[item.id] ?? { quantity: "", unit: row.baseUnit };
    const units = recipeDisplayUnitsFor(row.baseUnit, row.ingredient ? ingredientConversions[row.ingredient.id] ?? [] : []);
    return <div className="flex min-w-[172px] items-center gap-1.5">
      <input aria-label={`${row.name || labels.ingredient} ${item.sizeLabel ?? item.name}`} type="number" min="0.01" step="0.01" value={draft.quantity}
        onChange={(event) => setNewRow({ ...row, amounts: { ...row.amounts, [item.id]: { ...draft, quantity: event.target.value } } })}
        className="h-12 w-[88px] rounded-xl border border-line bg-card px-2 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/15" placeholder="—" />
      <select aria-label={`${labels.unit} ${item.sizeLabel ?? item.name}`} value={units.includes(draft.unit) ? draft.unit : units[0]}
        onChange={(event) => setNewRow({ ...row, amounts: { ...row.amounts, [item.id]: { ...draft, unit: event.target.value as RecipeDisplayUnit } } })}
        className="h-12 min-w-[74px] rounded-xl border border-line bg-card px-2 focus:border-ink focus:outline-none">
        {units.map((unit) => <option key={unit} value={unit}>{labels[unit] ?? unit}</option>)}
      </select>
    </div>;
  }

  return <section className="rounded-card-lg bg-card p-3 sm:p-[18px]">
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[760px] border-separate border-spacing-0">
        <thead><tr className="bg-paper/70">
          <th className="sticky start-0 z-20 min-w-[220px] border-b border-line bg-paper p-3 text-start">{labels.ingredient}</th>
          {items.map((item) => <th key={item.id} className={`min-w-[210px] border-b border-line p-3 text-center ${focusedSizeId === item.id ? "bg-warn-tint/55" : ""} ${item.active ? "" : "text-ink-muted"}`}>
            <span className="text-lg font-extrabold">{item.sizeLabel ?? item.name}</span>
            {!item.active && <span className="block text-[17px] font-medium">{labels.inactive}</span>}
            {focusedSizeId === item.id && <span className="mx-auto mt-1 block w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[15px] font-bold text-warn">{item.costStatus === "NO_RECIPE" ? labels.noRecipe : item.costStatus === "MISSING_INGREDIENT_COST" ? labels.missingCost : labels.focused}</span>}
          </th>)}
        </tr></thead>
        <tbody>
          {rows.map(([ingredientId, name]) => <tr key={ingredientId}>
            <th className="sticky start-0 z-10 border-b border-line bg-card p-3 text-start font-bold">{name}</th>
            {items.map((item) => {
              const line = item.recipe.find((candidate) => candidate.ingredientId === ingredientId);
              const key = `${item.id}:${ingredientId}`;
              const representative = items.flatMap((candidate) => candidate.recipe).find((candidate) => candidate.ingredientId === ingredientId)!;
              const draft = drafts[key] ?? (line ? draftForLine(line) : { quantity: "", unit: representative.baseUnit });
              return <td key={item.id} className={`border-b border-line p-2.5 ${focusedSizeId === item.id ? "bg-warn-tint/25" : ""} ${item.active ? "" : "bg-paper/60"}`}>
                {!draft.removed ? <div className="flex min-w-[190px] items-center justify-center gap-1">
                  <input aria-label={`${name} ${item.sizeLabel ?? item.name}`} className="h-12 w-[82px] rounded-xl border border-line px-2 focus:border-ink focus:outline-none" type="number" min="0.01" step="0.01" value={draft.quantity} onChange={(event) => setDrafts((current) => ({ ...current, [key]: { ...draft, quantity: event.target.value } }))} />
                  <select aria-label={`${labels.unit} ${name}`} className="h-12 min-w-[70px] rounded-xl border border-line bg-card px-1" value={draft.unit} onChange={(event) => setDrafts((current) => ({ ...current, [key]: { ...draft, unit: event.target.value as RecipeDisplayUnit } }))}>
                    {recipeDisplayUnitsFor(representative.baseUnit, ingredientConversions[ingredientId] ?? []).map((unit) => <option key={unit} value={unit}>{labels[unit] ?? unit}</option>)}
                  </select>
                  {line ? <button type="button" aria-label={`${labels.remove} ${name} ${item.sizeLabel ?? item.name}`} onClick={() => setDrafts((current) => ({ ...current, [key]: { ...draft, removed: true } }))} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl text-warn hover:bg-warn-tint"><Trash2 size={18} aria-hidden="true" /></button> : <span className="min-w-12 text-center text-ink-muted" aria-label={labels.notUsed}>—</span>}
                </div> : <button type="button" onClick={() => setDrafts((current) => ({ ...current, [key]: { ...draft, removed: false } }))} className="min-h-12 w-full font-bold text-good">{labels.undo}</button>}
              </td>;
            })}
          </tr>)}
          {newRow && <tr className="bg-good-tint/35">
            <th className="sticky start-0 z-10 border-b border-good/20 bg-[#f5faf7] p-2 align-top text-start">
              <div className="relative">
                <label className="flex h-12 items-center rounded-xl border border-good bg-card px-3 ring-2 ring-good/10">
                  <Search size={18} aria-hidden="true" className="shrink-0 text-ink-muted" />
                  <input autoFocus value={newRow.name} onFocus={() => setIngredientOpen(true)} onChange={(event) => updateIngredientName(event.target.value)} placeholder={labels.search} className="min-w-0 flex-1 px-2 outline-none" />
                  <ChevronDown size={18} aria-hidden="true" />
                </label>
                {ingredientOpen && query && <div className="absolute start-0 top-[52px] z-30 max-h-60 w-[280px] overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-xl">
                  {suggestions.map((ingredient) => <button type="button" key={ingredient.id} onClick={() => chooseIngredient(ingredient)} className="flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-start hover:bg-paper"><span>{ingredient.name}</span><span className="text-sm text-ink-muted">{labels[ingredient.baseUnit]}</span></button>)}
                  {suggestions.length === 0 && exactIngredient && <button type="button" onClick={() => chooseIngredient(exactIngredient)} className="min-h-12 w-full rounded-lg px-3 text-start font-bold text-good"><Check className="me-2 inline" size={17} />{exactIngredient.name} · {labels.existing}</button>}
                  {suggestions.length === 0 && !exactIngredient && <button type="button" onClick={() => setIngredientOpen(false)} className="min-h-12 w-full rounded-lg px-3 text-start font-bold text-good"><Plus className="me-2 inline" size={17} />{labels.createNamed.replace("{name}", newRow.name.trim())}</button>}
                </div>}
                {!newRow.ingredient && <div className="mt-2 grid grid-cols-3 gap-1" aria-label={labels.type}>
                  {(["g", "ml", "each"] as const).map((baseUnit) => <button type="button" key={baseUnit} onClick={() => setBaseUnit(baseUnit)} className={`min-h-12 rounded-xl px-1 text-sm font-bold ${newRow.baseUnit === baseUnit ? "bg-ink text-paper" : "border border-line bg-card text-ink-muted"}`}>{labels[baseUnit]}</button>)}
                </div>}
                {!newRow.ingredient && !exactIngredient && <div className="mt-2 rounded-xl border border-line bg-card p-2">
                  <span className="text-sm font-bold text-ink-muted">{labels.purchaseCost}</span>
                  <div className="mt-1 flex items-center gap-1">
                    <label className="flex h-12 min-w-0 flex-1 items-center rounded-lg border border-line px-2"><span aria-hidden="true">$</span><input inputMode="decimal" aria-label={labels.purchasePrice} value={newRow.purchaseCost} onChange={(event) => setNewRow({ ...newRow, purchaseCost: event.target.value })} className="min-w-0 flex-1 px-1 outline-none" placeholder="0.00" /></label>
                    <span aria-hidden="true" className="text-ink-muted">/</span>
                    <input inputMode="decimal" aria-label={labels.purchaseQuantity} value={newRow.purchaseQuantity} onChange={(event) => setNewRow({ ...newRow, purchaseQuantity: event.target.value })} className="h-12 w-16 rounded-lg border border-line px-2 outline-none" placeholder="0" />
                    <select aria-label={labels.purchaseUnit} value={newRow.purchaseUnit} onChange={(event) => setNewRow({ ...newRow, purchaseUnit: event.target.value as RecipeDisplayUnit })} className="h-12 w-[74px] rounded-lg border border-line bg-card px-1">
                      {recipeDisplayUnitsFor(newRow.baseUnit).map((unit) => <option key={unit} value={unit}>{labels[unit] ?? unit}</option>)}
                    </select>
                  </div>
                </div>}
              </div>
            </th>
            {items.map((item) => <td key={item.id} className={`border-b border-good/20 p-2.5 ${focusedSizeId === item.id ? "bg-warn-tint/25" : ""}`}>{amountCell(newRow, item)}</td>)}
          </tr>}
        </tbody>
      </table>
    </div>
    {!newRow && <button type="button" onClick={beginRow} className="mt-3 flex min-h-12 items-center rounded-xl px-3 font-bold text-good hover:bg-good-tint"><Plus className="me-2" size={19} />{labels.addIngredient}</button>}
    {newRow && <button type="button" onClick={() => setNewRow(null)} className="mt-2 flex min-h-12 items-center px-3 font-bold text-warn"><Trash2 className="me-2" size={18} />{labels.removeDraft}</button>}
    {error && <p className="mt-3 font-semibold text-warn" role="alert">{error}</p>}
    {saved && <p className="mt-3 flex items-center gap-2 font-semibold text-good"><Check size={18} />{labels.saved}</p>}
    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" disabled={pending} onClick={reset} className="min-h-12 rounded-full border border-line px-7 font-bold">{labels.cancel}</button>
      <button type="button" disabled={pending} onClick={save} className="min-h-12 rounded-full bg-ink px-7 font-bold text-paper disabled:opacity-40">{labels.saveRecipe}</button>
    </div>
  </section>;
}
