"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { addRecipeLine, deleteRecipeLine, updateRecipeLine } from "@/lib/actions/menuItems";
import { recipeDisplayUnitsFor, type IngredientUnitConversion, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";

type CellDraft = { quantity: string; unit: RecipeDisplayUnit; remove?: boolean };

export default function RecipeMatrix({ sizes, ingredients, ingredientConversions }: { sizes: MenuItemForEdit[]; ingredients: IngredientOption[]; ingredientConversions: Record<string, IngredientUnitConversion[]> }) {
  const t = useTranslations("ManageMenu");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [newIngredientId, setNewIngredientId] = useState("");
  const ingredientById = useMemo(() => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])), [ingredients]);
  const recipeIngredientIds = useMemo(() => [...new Set(sizes.flatMap((size) => size.recipe.map((line) => line.ingredientId)))], [sizes]);
  const initialDrafts = () => Object.fromEntries(recipeIngredientIds.flatMap((ingredientId) => sizes.map((size) => { const line = size.recipe.find((candidate) => candidate.ingredientId === ingredientId); const ingredient = ingredientById.get(ingredientId); return [`${size.id}:${ingredientId}`, { quantity: line ? String(line.displayQuantity ?? line.quantity) : "", unit: (line?.displayUnit ?? line?.baseUnit ?? ingredient?.baseUnit ?? "each") as RecipeDisplayUnit }]; })));
  const [drafts, setDrafts] = useState<Record<string, CellDraft>>(initialDrafts);
  const [newCells, setNewCells] = useState<Record<string, CellDraft>>({});
  const selectedIngredient = ingredientById.get(newIngredientId);
  const filtered = ingredients.filter((ingredient) => !recipeIngredientIds.includes(ingredient.id) && ingredient.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  function reset() { setDrafts(initialDrafts()); setNewCells({}); setAdding(false); setNewIngredientId(""); setQuery(""); setError(null); setEditing(false); }
  function updateCell(key: string, patch: Partial<CellDraft>) { setDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } })); }

  function save() {
    setError(null);
    startTransition(async () => {
      for (const size of sizes) for (const line of size.recipe) {
        const key = `${size.id}:${line.ingredientId}`;
        const draft = drafts[key];
        const result = draft.remove
          ? await deleteRecipeLine(size.id, line.ingredientId)
          : await updateRecipeLine({ menuItemId: size.id, ingredientId: line.ingredientId, displayQuantity: Number(draft.quantity), displayUnit: draft.unit });
        if (!result.ok) { setError(result.error); return; }
      }
      for (const ingredientId of recipeIngredientIds) for (const size of sizes) {
        if (size.recipe.some((line) => line.ingredientId === ingredientId)) continue;
        const draft = drafts[`${size.id}:${ingredientId}`];
        if (!draft || draft.remove || !(Number(draft.quantity) > 0)) continue;
        const result = await addRecipeLine({ menuItemId: size.id, ingredientId, displayQuantity: Number(draft.quantity), displayUnit: draft.unit });
        if (!result.ok) { setError(result.error); return; }
      }
      if (selectedIngredient) for (const size of sizes) {
        const draft = newCells[size.id];
        if (!draft || !(Number(draft.quantity) > 0)) continue;
        const needsConversion = draft.unit === "shot" || draft.unit === "pump";
        const conversion = (ingredientConversions[selectedIngredient.id] ?? []).find((item) => item.unit === draft.unit);
        if (needsConversion && !conversion) { setError(t("conversionRequired")); return; }
        const result = await addRecipeLine({ menuItemId: size.id, ingredientId: selectedIngredient.id, displayQuantity: Number(draft.quantity), displayUnit: draft.unit });
        if (!result.ok) { setError(result.error); return; }
      }
      setEditing(false); setAdding(false); router.refresh();
    });
  }

  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#FBF3E7] p-4">
      <div><h2 className="text-lg font-bold text-ink">{t("recipeMatrixTitle")}</h2><p className="text-sm text-ink-muted">{t("recipeMatrixHint")}</p></div>
      <div className="flex gap-2">{editing && <button type="button" onClick={reset} className="min-h-12 rounded-full border border-line bg-card px-4 font-bold">{t("cancel")}</button>}<button type="button" onClick={editing ? save : () => setEditing(true)} disabled={pending} className="min-h-12 rounded-full bg-[#6F3F20] px-5 font-bold text-white disabled:opacity-50">{editing ? t("done") : t("editRecipe")}</button></div>
    </div>
    <div className="overflow-x-auto rounded-2xl border border-line bg-card">
      <table className="w-full min-w-[680px] border-collapse text-start"><thead><tr className="bg-[#F7EFE4]"><th className="p-3 text-start">{t("ingredientLabel")}</th>{sizes.map((size) => <th key={size.id} className="p-3 text-start">{size.sizeLabel ?? size.name}</th>)}{editing && <th className="p-3">{t("actions")}</th>}</tr></thead>
      <tbody>{recipeIngredientIds.map((ingredientId) => { const ingredient = ingredientById.get(ingredientId); return <tr key={ingredientId} className="border-t border-line"><th className="p-3 text-start font-bold">{ingredient?.name ?? sizes.flatMap((size) => size.recipe).find((line) => line.ingredientId === ingredientId)?.ingredientName}</th>{sizes.map((size) => { const line = size.recipe.find((candidate) => candidate.ingredientId === ingredientId); const key = `${size.id}:${ingredientId}`; const draft = drafts[key]; return <td key={size.id} className="p-2">{editing ? <div className="flex gap-1"><input aria-label={`${size.sizeLabel} ${ingredient?.name} ${t("quantityLabel")}`} value={draft.quantity} placeholder="—" onChange={(event) => updateCell(key, { quantity: event.target.value })} type="number" min="0.01" step="0.01" className="h-12 w-20 rounded-lg border border-line px-2"/><select value={draft.unit} onChange={(event) => updateCell(key, { unit: event.target.value as RecipeDisplayUnit })} className="h-12 rounded-lg border border-line px-2">{recipeDisplayUnitsFor(line?.baseUnit ?? ingredient?.baseUnit ?? "each").map((unit) => <option key={unit} value={unit}>{unit.replace("_", " ")}</option>)}</select></div> : line ? <span className="font-semibold">{line.displayQuantity ?? line.quantity} {(line.displayUnit ?? line.baseUnit).replace("_", " ")}</span> : <span className="text-ink-muted">—</span>}</td>; })}{editing && <td className="p-2"><button type="button" onClick={() => sizes.forEach((size) => { const key = `${size.id}:${ingredientId}`; if (drafts[key]) updateCell(key, { remove: true }); })} className="flex min-h-12 min-w-12 items-center justify-center text-warn" aria-label={t("remove")}><Trash2 aria-hidden size={18}/></button></td>}</tr>; })}</tbody></table>
    </div>
    {editing && <>{!adding ? <button type="button" onClick={() => setAdding(true)} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-[#B77A43] bg-[#FFF8EE] font-bold text-[#6F3F20]"><Plus aria-hidden size={18}/>{t("addIngredient")}</button> : <div className="rounded-2xl border border-line bg-card p-3"><label className="flex min-h-12 items-center gap-2 rounded-xl border border-line px-3"><Search aria-hidden size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("ingredientSearchLabel")} className="min-w-0 flex-1 outline-none"/></label>{!selectedIngredient ? <div className="mt-2 max-h-40 overflow-y-auto">{filtered.map((ingredient) => <button key={ingredient.id} type="button" onClick={() => { setNewIngredientId(ingredient.id); const unit = recipeDisplayUnitsFor(ingredient.baseUnit)[0]; setNewCells(Object.fromEntries(sizes.map((size) => [size.id, { quantity: "", unit }]))); }} className="flex min-h-12 w-full items-center px-3 text-start">{ingredient.name}</button>)}</div> : <div className="mt-3"><p className="mb-2 font-bold">{selectedIngredient.name} · {selectedIngredient.baseUnit === "g" ? t("typeWeight") : selectedIngredient.baseUnit === "ml" ? t("typeVolume") : t("typeCount")}</p><div className="grid gap-2 sm:grid-cols-3">{sizes.map((size) => <label key={size.id} className="text-sm font-bold">{size.sizeLabel ?? size.name}<div className="mt-1 flex gap-1"><input value={newCells[size.id]?.quantity ?? ""} onChange={(event) => setNewCells((current) => ({ ...current, [size.id]: { ...current[size.id], quantity: event.target.value } }))} type="number" min="0.01" step="0.01" className="h-12 w-20 rounded-lg border border-line px-2"/><select value={newCells[size.id]?.unit} onChange={(event) => setNewCells((current) => ({ ...current, [size.id]: { ...current[size.id], unit: event.target.value as RecipeDisplayUnit } }))} className="h-12 rounded-lg border border-line px-2">{recipeDisplayUnitsFor(selectedIngredient.baseUnit).map((unit) => <option key={unit} value={unit}>{unit.replace("_", " ")}</option>)}</select></div></label>)}</div></div>}</div>}</>}
    {error && <p role="alert" className="rounded-xl bg-warn-tint p-3 font-semibold text-warn">{error}</p>}
  </div>;
}
