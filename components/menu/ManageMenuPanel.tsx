"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { addMenuItem, addRecipeLine, deleteRecipeLine, setMenuItemActive } from "@/lib/actions/menuItems";
import { formatCents, type PricingResult } from "@/lib/calc";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import { MENU_ITEM_CATEGORY_CODES, type MenuItemCategoryCode } from "@/lib/constants";

type Labels = {
  addDrink: string;
  nameLabel: string;
  sizeLabel: string;
  sizeHint: string;
  addAnotherSize: string;
  priceLabel: string;
  prepSecondsLabel: string;
  prepSecondsHelp: string;
  categoryLabel: string;
  categories: Record<MenuItemCategoryCode, string>;
  add: string;
  noItems: string;
  recipe: string;
  recipeHint: string;
  ingredientAdded: string;
  noIngredientsYet: string;
  ingredientColumnLabel: string;
  amountColumnLabel: string;
  ingredientLabel: string;
  quantityLabel: string;
  newIngredient: string;
  ingredientCostLabel: string;
  ingredientCostForLabel: string;
  ingredientCostHint: string;
  unitG: string;
  unitMl: string;
  unitEach: string;
  addIngredient: string;
  remove: string;
  deactivate: string;
  reactivate: string;
  inactiveTag: string;
  suggestedPriceLabel: string;
  suggestedPriceHint: string;
  pricingStatus: Record<PricingResult["status"], string>;
  pricingExplainer: Record<PricingResult["explanationCode"], string>;
  pricingWarnings: Record<PricingResult["warnings"][number], string>;
};

/** Groups a list of sizes/items sharing one base name (e.g. "Latte" → 12/16/18 oz), preserving
 * the order each base name first appears in — items with no size are their own group of one. */
function groupByBaseName(items: MenuItemForEdit[]): { baseName: string; items: MenuItemForEdit[] }[] {
  const order: string[] = [];
  const groups = new Map<string, MenuItemForEdit[]>();
  for (const item of items) {
    if (!groups.has(item.baseName)) {
      order.push(item.baseName);
      groups.set(item.baseName, []);
    }
    groups.get(item.baseName)!.push(item);
  }
  return order.map((baseName) => ({ baseName, items: groups.get(baseName)! }));
}

export default function ManageMenuPanel({
  items,
  ingredients,
  labels,
  pricing,
}: {
  items: MenuItemForEdit[];
  ingredients: IngredientOption[];
  labels: Labels;
  pricing: Record<string, PricingResult>;
}) {
  const [name, setName] = useState("");
  const [sizeLabel, setSizeLabel] = useState("");
  const [price, setPrice] = useState("");
  const [prepMinutes, setPrepMinutes] = useState("1");
  const [category, setCategory] = useState<MenuItemCategoryCode>("ESPRESSO_DRINK");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function handleAdd() {
    const priceCents = Math.round((Number(price) || 0) * 100);
    const seconds = Math.round((Number(prepMinutes) || 0) * 60);
    if (!name.trim() || priceCents <= 0 || seconds <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem({
        name: name.trim(),
        sizeLabel: sizeLabel.trim() || undefined,
        priceCents,
        prepSeconds: seconds,
        category,
      });
      if (result.ok) {
        setName("");
        setSizeLabel("");
        setPrice("");
        setPrepMinutes("1");
        setExpanded((prev) => new Set(prev).add(result.id));
      } else {
        setError(result.error);
      }
    });
  }

  function handleAddAnotherSize(baseName: string) {
    setName(baseName);
    setSizeLabel("");
    setPrice("");
    setPrepMinutes("1");
    setError(null);
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const active = items.filter((i) => i.active);
  const inactive = items.filter((i) => !i.active);
  const activeGroups = groupByBaseName(active);
  const inactiveGroups = groupByBaseName(inactive);

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="flex items-center gap-2 text-[17px] font-bold">
          <Plus aria-hidden="true" size={20} />
          {labels.addDrink}
        </h2>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={labels.nameLabel} className="h-12 rounded-xl border border-line px-3 text-base" />
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={sizeLabel}
            onChange={(e) => setSizeLabel(e.target.value)}
            placeholder={labels.sizeLabel}
            className="h-12 rounded-xl border border-line px-3 text-base"
          />
          <span className="text-xs text-ink-muted">{labels.sizeHint}</span>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-semibold text-ink-muted">{labels.priceLabel}</span>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-lg font-bold text-ink-muted">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="h-12 w-full min-w-0 rounded-xl border border-line px-3 text-base"
              />
            </div>
          </label>
          <label className="flex w-28 shrink-0 flex-col gap-1">
            <span className="text-xs font-semibold text-ink-muted">{labels.prepSecondsLabel}</span>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={prepMinutes}
              onChange={(e) => setPrepMinutes(e.target.value)}
              className="h-12 w-full min-w-0 rounded-xl border border-line px-2 text-base"
            />
          </label>
        </div>
        <p className="-mt-1.5 text-xs text-ink-muted">{labels.prepSecondsHelp}</p>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.categoryLabel}
          <select value={category} onChange={(event) => setCategory(event.target.value as MenuItemCategoryCode)} className="h-12 rounded-xl border border-line bg-card px-3 text-base text-ink">
            {MENU_ITEM_CATEGORY_CODES.map((code) => <option key={code} value={code}>{labels.categories[code]}</option>)}
          </select>
        </label>
        {error && <p className="text-sm text-warn">{error}</p>}
        <button
          type="button"
          onClick={handleAdd}
          disabled={isPending || !name.trim() || !price}
          className="h-12 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40"
        >
          {labels.add}
        </button>
      </section>

      <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-2">
        {activeGroups.length === 0 ? (
          <p className="py-4 text-[15px] text-ink-muted">{labels.noItems}</p>
        ) : (
          activeGroups.map((group) => (
            <MenuItemGroup key={group.baseName} group={group} ingredients={ingredients} labels={labels} pricing={pricing} expanded={expanded} onToggle={toggleExpanded} onAddAnotherSize={handleAddAnotherSize} />
          ))
        )}
      </section>

      {inactiveGroups.length > 0 && (
        <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-2 opacity-70">
          {inactiveGroups.map((group) => (
            <MenuItemGroup key={group.baseName} group={group} ingredients={ingredients} labels={labels} pricing={pricing} expanded={expanded} onToggle={() => {}} onAddAnotherSize={() => {}} />
          ))}
        </section>
      )}
    </div>
  );
}

function MenuItemGroup({
  group,
  ingredients,
  labels,
  pricing,
  expanded,
  onToggle,
  onAddAnotherSize,
}: {
  group: { baseName: string; items: MenuItemForEdit[] };
  ingredients: IngredientOption[];
  labels: Labels;
  pricing: Record<string, PricingResult>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAddAnotherSize: (baseName: string) => void;
}) {
  const isSized = group.items.length > 1 || Boolean(group.items[0]?.sizeLabel);

  return (
    <div className="border-b border-line py-2 last:border-b-0">
      {isSized && (
        <div className="flex items-center justify-between gap-2 px-0 pb-1 pt-1">
          <span className="text-sm font-bold text-ink-muted">{group.baseName}</span>
          <button type="button" onClick={() => onAddAnotherSize(group.baseName)} className="text-xs font-semibold text-good">
            {labels.addAnotherSize.replace("{name}", group.baseName)}
          </button>
        </div>
      )}
      {group.items.map((item) => (
        <MenuItemRow key={item.id} item={item} ingredients={ingredients} labels={labels} pricingResult={pricing[item.id]} expanded={expanded.has(item.id)} onToggle={() => onToggle(item.id)} indent={isSized} />
      ))}
    </div>
  );
}

function MenuItemRow({
  item,
  ingredients,
  labels,
  pricingResult,
  expanded,
  onToggle,
  indent,
}: {
  item: MenuItemForEdit;
  ingredients: IngredientOption[];
  labels: Labels;
  pricingResult?: PricingResult;
  expanded: boolean;
  onToggle: () => void;
  indent: boolean;
}) {
  const [ingredientId, setIngredientId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<"g" | "ml" | "each">("g");
  const [newCost, setNewCost] = useState("");
  const [newCostQuantity, setNewCostQuantity] = useState("");
  const [quantity, setQuantity] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState(false);

  function handleAddLine() {
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    if (!ingredientId && !newName.trim()) return;
    const costCents = Math.round((Number(newCost) || 0) * 100);
    const costQuantity = Number(newCostQuantity) || 0;
    setError(null);
    setJustAdded(false);
    startTransition(async () => {
      const result = await addRecipeLine({
        menuItemId: item.id,
        ingredientId: ingredientId || undefined,
        newIngredientName: ingredientId ? undefined : newName.trim(),
        newIngredientUnit: ingredientId ? undefined : newUnit,
        newIngredientCostCents: !ingredientId && costCents > 0 && costQuantity > 0 ? costCents : undefined,
        newIngredientCostQuantity: !ingredientId && costCents > 0 && costQuantity > 0 ? costQuantity : undefined,
        quantity: qty,
      });
      if (result.ok) {
        setQuantity("");
        setNewName("");
        setNewCost("");
        setNewCostQuantity("");
        setIngredientId("");
        setJustAdded(true);
      } else {
        setError(result.error);
      }
    });
  }

  function handleRemoveLine(ingId: string) {
    startTransition(() => {
      void deleteRecipeLine(item.id, ingId);
    });
  }

  function handleToggleActive() {
    startTransition(() => {
      void setMenuItemActive(item.id, !item.active);
    });
  }

  return (
    <div className={`py-2 ${indent ? "pl-3" : ""}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-bold">
            {item.sizeLabel ?? item.name} · {formatCents(item.priceCents)}
          </span>
          {!item.active && <span className="text-xs font-semibold text-warn">{labels.inactiveTag}</span>}
        </div>
        {expanded ? <ChevronUp aria-hidden="true" size={18} /> : <ChevronDown aria-hidden="true" size={18} />}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-[#FAF6F0] p-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-bold">{labels.recipe}</span>
            <span className="text-xs text-ink-muted">{labels.recipeHint}</span>
          </div>
          {item.recipe.length === 0 ? (
            <p className="text-sm text-ink-muted">{labels.noIngredientsYet}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-0 border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-muted">
                    <th scope="col" className="min-w-0 pb-1 pr-2 font-semibold">
                      {labels.ingredientColumnLabel}
                    </th>
                    <th scope="col" className="pb-1 pr-2 text-right font-semibold">
                      {labels.amountColumnLabel}
                    </th>
                    <th scope="col" className="w-8 pb-1">
                      <span className="sr-only">{labels.remove}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {item.recipe.map((line) => (
                    <tr key={line.ingredientId} className="border-t border-[#EFE7DB]">
                      <td className="min-w-0 max-w-0 truncate py-1.5 pr-2">{line.ingredientName}</td>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-right text-ink-muted">
                        {line.quantity} {line.baseUnit}
                      </td>
                      <td className="py-1.5 text-right">
                        <button type="button" onClick={() => handleRemoveLine(line.ingredientId)} disabled={isPending} aria-label={labels.remove} className="text-warn">
                          <Trash2 aria-hidden="true" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pricingResult && pricingResult.productCostCents > 0 && (
            <div className="flex flex-col gap-0.5 rounded-xl bg-good-tint px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-good">{labels.pricingStatus[pricingResult.status]}</span>
                <span className="text-base font-bold text-good">{formatCents(pricingResult.recommendedPriceCents)}</span>
              </div>
              <span className="text-xs text-good">{labels.pricingExplainer[pricingResult.explanationCode]}</span>
              {pricingResult.warnings.map((warning) => <span key={warning} className="text-xs font-semibold text-warn">{labels.pricingWarnings[warning]}</span>)}
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-[#EFE7DB] pt-3">
            <select
              value={ingredientId}
              onChange={(e) => setIngredientId(e.target.value)}
              className="h-11 w-full min-w-0 rounded-lg border border-line px-2.5 text-sm"
            >
              <option value="">{labels.newIngredient}</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.baseUnit})
                </option>
              ))}
            </select>
            {!ingredientId && (
              <div className="flex min-w-0 gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={labels.ingredientLabel}
                  className="h-11 w-full min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
                />
                <select value={newUnit} onChange={(e) => setNewUnit(e.target.value as "g" | "ml" | "each")} className="h-11 w-28 min-w-0 shrink-0 rounded-lg border border-line px-1 text-sm">
                  <option value="g">{labels.unitG}</option>
                  <option value="ml">{labels.unitMl}</option>
                  <option value="each">{labels.unitEach}</option>
                </select>
              </div>
            )}
            {!ingredientId && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-ink-muted">{labels.ingredientCostLabel}</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 font-bold text-ink-muted">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={newCost}
                    onChange={(e) => setNewCost(e.target.value)}
                    className="h-11 min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
                  />
                  <span className="shrink-0 text-xs text-ink-muted">{labels.ingredientCostForLabel}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={newCostQuantity}
                    onChange={(e) => setNewCostQuantity(e.target.value)}
                    className="h-11 w-20 min-w-0 shrink-0 rounded-lg border border-line px-2 text-sm"
                  />
                  <span className="shrink-0 text-xs text-ink-muted">{newUnit === "each" ? labels.unitEach : newUnit}</span>
                </div>
                <span className="text-xs text-ink-muted">{labels.ingredientCostHint}</span>
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={labels.quantityLabel}
                className="h-11 w-full min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
              />
              <button
                type="button"
                onClick={handleAddLine}
                disabled={isPending || !quantity}
                className="h-11 shrink-0 rounded-full bg-ink px-4 text-sm font-bold text-paper disabled:opacity-40"
              >
                {labels.addIngredient}
              </button>
            </div>
            {error && <p className="text-sm text-warn">{error}</p>}
            {justAdded && !error && <p className="text-sm font-semibold text-good">{labels.ingredientAdded}</p>}
          </div>

          <button type="button" onClick={handleToggleActive} disabled={isPending} className="h-10 rounded-full border border-line text-sm font-semibold text-ink-muted">
            {item.active ? labels.deactivate : labels.reactivate}
          </button>
        </div>
      )}
    </div>
  );
}
