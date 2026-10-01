"use client";

import { useState, useTransition } from "react";
import { addManualIngredientPrice } from "@/lib/actions/menuItems";
import type { RecipeLineForEdit } from "@/lib/data/getMenuItemsForEdit";

export type MissingPriceLabels = { ingredientCostLabel: string; ingredientCostForLabel: string; add: string };

export default function MissingPriceForm({ line, labels }: { line: RecipeLineForEdit; labels: MissingPriceLabels }) {
  const [cost, setCost] = useState("");
  const [quantity, setQuantity] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg bg-warn-tint p-2 text-xs text-warn">
      <span className="w-full font-bold">{labels.ingredientCostLabel}: {line.ingredientName}</span>
      <span>$</span>
      <input value={cost} onChange={(event) => setCost(event.target.value)} inputMode="decimal" className="h-10 w-20 rounded-lg border border-line px-2 text-ink" />
      <span>{labels.ingredientCostForLabel}</span>
      <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" className="h-10 w-20 rounded-lg border border-line px-2 text-ink" />
      <span>{line.baseUnit}</span>
      <button
        type="button"
        disabled={pending || !cost || !quantity}
        onClick={() => startTransition(async () => { await addManualIngredientPrice({ ingredientId: line.ingredientId, packageCostCents: Math.round(Number(cost) * 100), packageQuantity: Number(quantity) }); })}
        className="min-h-10 rounded-full bg-ink px-3 font-bold text-paper disabled:opacity-40"
      >
        {labels.add}
      </button>
    </div>
  );
}
