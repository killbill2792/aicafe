"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";

type Filter = "all" | "coffee" | "tea" | "food" | "attention";
type Labels = Record<"search" | "all" | "coffee" | "tea" | "food" | "needsAttention" | "cost" | "afterIngredients" | "suggested" | "keepPrice" | "noRecipe" | "missingCost" | "syncedFrom" | "inactive" | "empty" | "addItem", string>;

export default function MenuCatalog({ items, labels }: { items: MenuControlItem[]; labels: Labels }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const visible = useMemo(() => items.filter((item) => {
    if (!item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return false;
    if (filter === "attention") return item.costStatus !== "READY";
    if (filter === "food") return ["FOOD", "PASTRY"].includes(item.category);
    if (filter === "tea") return item.category === "TEA";
    if (filter === "coffee") return ["ESPRESSO_DRINK", "BREWED_COFFEE", "COLD_BREW", "SPECIALTY_DRINK"].includes(item.category);
    return true;
  }), [filter, items, query]);

  return <>
    <label className="flex min-h-12 items-center gap-2 rounded-2xl bg-card px-3 text-ink-muted">
      <Search aria-hidden="true" size={20} /><span className="sr-only">{labels.search}</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={labels.search} className="min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none" />
    </label>
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={labels.all}>
      {([['all', labels.all], ['coffee', labels.coffee], ['tea', labels.tea], ['food', labels.food], ['attention', labels.needsAttention]] as const).map(([value, label]) =>
        <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`min-h-12 shrink-0 rounded-full px-4 text-sm font-bold ${filter === value ? "bg-ink text-paper" : "bg-card text-ink"}`}>{label}</button>)}
    </div>
    <div className="flex flex-col gap-3">
      {visible.map((item) => <Link key={item.id} href={`/menu/${item.id}`} className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px] text-ink no-underline">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-lg font-bold">{item.name}</h2>{item.sizeLabel && <p className="text-sm text-ink-muted">{item.sizeLabel}</p>}</div>
          <span className="shrink-0 font-headline text-[25px] font-bold">{formatCents(item.priceCents)}</span>
        </div>
        {item.costStatus === "READY" && item.ingredientsCostCents !== null ? <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[15px]"><span>{labels.cost} <strong>{formatCents(item.ingredientsCostCents)}</strong></span><span>{labels.afterIngredients} <strong>{formatCents(item.priceCents - item.ingredientsCostCents)}</strong></span></div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-good-tint" aria-hidden="true"><span className="bg-ingredients" style={{ width: `${Math.min(100, item.priceCents ? item.ingredientsCostCents / item.priceCents * 100 : 0)}%` }} /></div>
          {item.pricing && <p className="text-sm font-semibold text-good">{labels.suggested}: {item.pricing.status === "KEEP_CURRENT_PRICE" ? labels.keepPrice : formatCents(item.pricing.recommendedPriceCents)}</p>}
        </> : <div className="rounded-xl bg-warn-tint px-3 py-2 text-sm text-warn"><strong>{labels.needsAttention}</strong><br />{item.costStatus === "NO_RECIPE" ? labels.noRecipe : labels.missingCost.replace("{ingredient}", item.missingCostIngredientNames.join(", "))}</div>}
        <div className="flex flex-wrap gap-2 text-xs text-ink-muted">{item.catalogSource !== "manual" && <span>{labels.syncedFrom.replace("{source}", item.provenance.replace("_", " "))}</span>}{!item.active && <span>{labels.inactive}</span>}</div>
      </Link>)}
      {visible.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted">{labels.empty}</p>}
    </div>
    <Link href="/menu/manage?add=1" className="flex min-h-14 items-center justify-center gap-2 rounded-full bg-ink text-base font-bold text-paper no-underline"><Plus aria-hidden="true" size={20} />{labels.addItem}</Link>
  </>;
}
