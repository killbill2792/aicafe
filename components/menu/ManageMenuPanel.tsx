"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { addMenuItem, addRecipeLine, deleteRecipeLine, setMenuItemActive } from "@/lib/actions/menuItems";
import { formatCents } from "@/lib/calc";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";

type Labels = {
  addDrink: string;
  nameLabel: string;
  priceLabel: string;
  prepSecondsLabel: string;
  categoryDrink: string;
  categoryFood: string;
  add: string;
  noItems: string;
  recipe: string;
  noIngredientsYet: string;
  ingredientLabel: string;
  quantityLabel: string;
  newIngredient: string;
  unitG: string;
  unitMl: string;
  unitEach: string;
  addIngredient: string;
  remove: string;
  deactivate: string;
  reactivate: string;
  inactiveTag: string;
};

export default function ManageMenuPanel({
  items,
  ingredients,
  labels,
}: {
  items: MenuItemForEdit[];
  ingredients: IngredientOption[];
  labels: Labels;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [prepSeconds, setPrepSeconds] = useState("60");
  const [category, setCategory] = useState<"drink" | "food">("drink");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function handleAdd() {
    const priceCents = Math.round((Number(price) || 0) * 100);
    const seconds = Number(prepSeconds) || 0;
    if (!name.trim() || priceCents <= 0 || seconds <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem({ name: name.trim(), priceCents, prepSeconds: seconds, category });
      if (result.ok) {
        setName("");
        setPrice("");
        setPrepSeconds("60");
        setExpanded((prev) => new Set(prev).add(result.id));
      } else {
        setError(result.error);
      }
    });
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

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="flex items-center gap-2 text-[17px] font-bold">
          <Plus aria-hidden="true" size={20} />
          {labels.addDrink}
        </h2>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={labels.nameLabel} className="h-12 rounded-xl border border-line px-3 text-base" />
        <div className="flex min-w-0 gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="shrink-0 text-lg font-bold text-ink-muted">$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={labels.priceLabel}
              className="h-12 w-full min-w-0 rounded-xl border border-line px-3 text-base"
            />
          </div>
          <input
            type="number"
            min="1"
            value={prepSeconds}
            onChange={(e) => setPrepSeconds(e.target.value)}
            placeholder={labels.prepSecondsLabel}
            className="h-12 w-24 min-w-0 shrink-0 rounded-xl border border-line px-2 text-base"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCategory("drink")}
            className={`h-11 flex-1 rounded-xl text-sm font-semibold ${category === "drink" ? "bg-good-tint text-good" : "bg-paper text-ink-muted"}`}
          >
            {labels.categoryDrink}
          </button>
          <button
            type="button"
            onClick={() => setCategory("food")}
            className={`h-11 flex-1 rounded-xl text-sm font-semibold ${category === "food" ? "bg-good-tint text-good" : "bg-paper text-ink-muted"}`}
          >
            {labels.categoryFood}
          </button>
        </div>
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
        {active.length === 0 ? (
          <p className="py-4 text-[15px] text-ink-muted">{labels.noItems}</p>
        ) : (
          active.map((item) => (
            <MenuItemRow
              key={item.id}
              item={item}
              ingredients={ingredients}
              labels={labels}
              expanded={expanded.has(item.id)}
              onToggle={() => toggleExpanded(item.id)}
            />
          ))
        )}
      </section>

      {inactive.length > 0 && (
        <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-2 opacity-70">
          {inactive.map((item) => (
            <MenuItemRow key={item.id} item={item} ingredients={ingredients} labels={labels} expanded={false} onToggle={() => {}} />
          ))}
        </section>
      )}
    </div>
  );
}

function MenuItemRow({
  item,
  ingredients,
  labels,
  expanded,
  onToggle,
}: {
  item: MenuItemForEdit;
  ingredients: IngredientOption[];
  labels: Labels;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [ingredientId, setIngredientId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<"g" | "ml" | "each">("g");
  const [quantity, setQuantity] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAddLine() {
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    if (!ingredientId && !newName.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await addRecipeLine({
        menuItemId: item.id,
        ingredientId: ingredientId || undefined,
        newIngredientName: ingredientId ? undefined : newName.trim(),
        newIngredientUnit: ingredientId ? undefined : newUnit,
        quantity: qty,
      });
      if (result.ok) {
        setQuantity("");
        setNewName("");
        setIngredientId("");
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
    <div className="border-b border-line py-3 last:border-b-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-bold">
            {item.name} · {formatCents(item.priceCents)}
          </span>
          {!item.active && <span className="text-xs font-semibold text-warn">{labels.inactiveTag}</span>}
        </div>
        {expanded ? <ChevronUp aria-hidden="true" size={18} /> : <ChevronDown aria-hidden="true" size={18} />}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 rounded-2xl bg-[#FAF6F0] p-3.5">
          <span className="text-sm font-bold">{labels.recipe}</span>
          {item.recipe.length === 0 ? (
            <p className="text-sm text-ink-muted">{labels.noIngredientsYet}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {item.recipe.map((line) => (
                <div key={line.ingredientId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{line.ingredientName}</span>
                  <span className="shrink-0 text-ink-muted">
                    {line.quantity} {line.baseUnit}
                  </span>
                  <button type="button" onClick={() => handleRemoveLine(line.ingredientId)} disabled={isPending} aria-label={labels.remove} className="shrink-0 text-warn">
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                </div>
              ))}
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
          </div>

          <button type="button" onClick={handleToggleActive} disabled={isPending} className="h-10 rounded-full border border-line text-sm font-semibold text-ink-muted">
            {item.active ? labels.deactivate : labels.reactivate}
          </button>
        </div>
      )}
    </div>
  );
}
