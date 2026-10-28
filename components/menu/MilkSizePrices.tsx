"use client";
import {useTranslations} from "next-intl";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {swapCostPerSize,DEFAULT_TARGET_PRODUCT_COST_PERCENT} from "@/lib/metrics/core/modifierPricing";
import {formatCents} from "@/lib/calc";
import type {PricedPantry} from "./MenuAddonsPanel";
/** All active sizes of the chosen product; every size uses its OWN recipe quantity. */
export default function MilkSizePrices({items,fromMilkId,toMilkId,pantry}:{
  items:MenuItemForEdit[];fromMilkId:string|null;toMilkId:string;pantry:PricedPantry[];
}){
  const t=useTranslations("MenuBuilder"),note=useTranslations("MetricsNotes");
  const first=items.find(item=>item.active)??items[0];
  const grouped=items.filter(item=>item.baseName===first?.baseName);
  const active=grouped.filter(item=>item.active);
  const sizes=active.length?active:grouped;
  const ml=Object.fromEntries(sizes.map(item=>{
    const line=item.recipe.find(r=>r.ingredientId===fromMilkId)??
      item.recipe.find(r=>pantry.some(p=>p.id===r.ingredientId&&p.category==="milk"));
    // Canonical stored recipe quantity is already in ml if baseUnit is ml.
    // Never assume weight is interchangeable with milk volume.
    const quantity=line?.baseUnit==="ml"?line.quantity:null;
    return [item.id,{ml:quantity,basis:quantity===null?"missing" as const:"recorded" as const}];
  }));
  const costs=Object.fromEntries(pantry.filter(p=>p.category==="milk").map(p=>[p.id,{
    costPerMlMicros:p.baseUnit==="ml"?p.costPerBaseMicros:null,
    basis:p.baseUnit==="ml"&&p.costPerBaseMicros!==null?
      "recorded" as const:"missing" as const,
  }]));
  const prices=swapCostPerSize(sizes.map(item=>({
    id:item.id,label:item.sizeLabel??item.name,
  })),fromMilkId??"unknown",toMilkId,ml,costs,DEFAULT_TARGET_PRODUCT_COST_PERCENT);
  return <div className="mt-2 space-y-2" aria-label={note("modifierSizePrices")}>
    {prices.sizes.map(size=><section key={size.sizeId}
      className="rounded-xl border border-line bg-paper p-2 text-base"
      data-size-label={size.sizeLabel}>
      <p className="font-bold">{t("costBasisForSize",{size:size.sizeLabel})}</p>
      {size.costDeltaCents===null?
        <p className="text-ink-muted">{note("modifierMissingInput")}: {size.missing.join(", ")}</p>:
        <>
          <p>{size.costDeltaCents===0?t("aboutSame"):
            size.costDeltaCents<0?t("savesYou",{amount:formatCents(Math.abs(size.costDeltaCents))}):
            t("costsYou",{amount:formatCents(size.costDeltaCents)})}</p>
          <p>{note("modifierSuggestedUpcharge")}: <strong>{formatCents(size.suggestedUpchargeCents!)}</strong></p>
          <p>{note("modifierMarginKept")}: {formatCents(size.marginKeptCents!)}</p>
        </>}
    </section>)}
    <p className="text-sm text-ink-muted">{note("modifierDefaultTarget")}</p>
  </div>;
}
