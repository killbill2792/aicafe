"use client";

import { useState } from "react";
import { Camera, Check, Pencil, Plus, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { setMenuItemActive } from "@/lib/actions/menuItems";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { IngredientUnitConversion } from "@/lib/calc/recipeUnits";
import { type MenuDetailTab } from "@/lib/viewmodels/menuDetail";
import { stableSortSizes } from "@/lib/menu/sizeLabel";
import ProductEditForm from "./ProductEditForm";
import AddSizeDialog, { type SizeSibling } from "./AddSizeDialog";
import RecipeMatrix from "./RecipeMatrix";
import { usePricingStatusChip } from "./usePricingStatusChip";

type SalesPeriod = "today" | "last7" | "last30";

export default function ProductDetailScreen({ item, editItem, editSizes, ingredients, menuGroupOptions, ingredientConversions, siblingSizes, initialTab, initialEditing = false }: {
  item: MenuControlItem; editItem: MenuItemForEdit; editSizes: MenuItemForEdit[]; ingredients: IngredientOption[]; menuGroupOptions: string[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>; siblingSizes: MenuControlItem[]; justCreated?: boolean;
  initialTab: MenuDetailTab; initialEditing?: boolean; copiedFrom?: string;
}) {
  const t = useTranslations("Menu");
  const te = useTranslations("ManageMenu");
  const router = useRouter();
  const pathname = usePathname();
  const pricingChip = usePricingStatusChip();
  const [tab, setTab] = useState<MenuDetailTab>(initialTab);
  const [editingItemId, setEditingItemId] = useState<string | null>(initialEditing ? item.id : null);
  const [addingSize, setAddingSize] = useState(false);
  const [period, setPeriod] = useState<SalesPeriod>("last30");
  const [error, setError] = useState<string | null>(null);
  const allSizes = stableSortSizes([item, ...siblingSizes]);
  const editById = new Map(editSizes.map((size) => [size.id, size]));
  const activeCount = allSizes.filter((size) => size.active).length;

  function chooseTab(next: MenuDetailTab) { setTab(next); router.replace(`${pathname}?tab=${next}`, { scroll: false }); }
  async function toggleSize(size: MenuControlItem) { setError(null); const result = await setMenuItemActive(size.id, !size.active); if (result.ok) router.refresh(); else setError(result.error); }

  return <>
    <section className="grid gap-4 rounded-card-lg bg-card p-[18px] shadow-sm sm:grid-cols-[220px_1fr]">
      <div className="relative flex min-h-44 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-[#E8C79F] to-[#8B5A38] text-white">
        <span className="text-6xl" aria-hidden>☕</span>
        <button type="button" disabled title={t("photoBackendGap")} className="absolute bottom-3 end-3 flex min-h-12 items-center gap-2 rounded-full bg-white px-4 text-sm font-bold text-ink opacity-90 disabled:cursor-not-allowed"><Camera aria-hidden size={18}/>{t("editPhoto")}</button>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-3">
        <p className="text-sm font-semibold text-ink-muted">{editItem.menuGroup ?? t("menuItem")}</p>
        <div className="flex flex-wrap items-center gap-3"><h1 className="font-headline text-4xl font-bold text-ink">{editItem.baseName}</h1><button type="button" onClick={() => setEditingItemId(item.id)} className="flex min-h-12 items-center gap-2 rounded-full border border-line px-3 font-bold"><Pencil aria-hidden size={17}/>{t("editName")}</button></div>
        <span className={`w-fit rounded-full px-3 py-2 text-sm font-bold ${activeCount > 0 ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>{activeCount > 0 ? t("activeSizes", { count: activeCount }) : t("inactive")}</span>
        <p className="text-sm text-ink-muted">{t("photoBackendGap")}</p>
      </div>
    </section>

    {editingItemId && editById.get(editingItemId) && <section className="rounded-card-lg border border-line bg-card p-[18px]"><div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-bold">{t("editProduct")}</h2><button type="button" onClick={() => setEditingItemId(null)} className="min-h-12 px-3 font-bold text-ink-muted">{te("cancel")}</button></div><ProductEditForm item={editById.get(editingItemId)!} menuGroupOptions={menuGroupOptions} labels={productFormLabels(te)} onSaved={() => { setEditingItemId(null); router.refresh(); }}/></section>}

    <div className="flex border-b border-line" role="tablist">{(["overview", "recipe"] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => chooseTab(key)} className={`min-h-14 border-b-4 px-6 text-[17px] font-bold ${tab === key ? "border-[#6F3F20] text-[#6F3F20]" : "border-transparent text-ink-muted"}`}>{t(key === "overview" ? "tabOverview" : "tabRecipe")}</button>)}</div>

    {tab === "overview" && <section className="flex flex-col gap-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-headline text-3xl font-bold">{t("sizes")}</h2><p className="text-ink-muted">{t("sizesOverviewHint")}</p></div><button type="button" onClick={() => setAddingSize(true)} className="flex min-h-12 items-center gap-2 rounded-xl bg-[#6F3F20] px-4 font-bold text-white"><Plus aria-hidden size={19}/>{t("addSize")}</button></div>
      <div className="inline-flex w-fit rounded-xl bg-[#EFE5D7] p-1" aria-label={t("salesPeriod")}>{(["today", "last7", "last30"] as const).map((value) => <button key={value} type="button" onClick={() => setPeriod(value)} aria-pressed={period === value} className={`min-h-12 rounded-lg px-3 text-sm font-bold ${period === value ? "bg-card text-ink shadow-sm" : "text-ink-muted"}`}>{t(`period_${value}`)}</button>)}</div>
      <div className="grid gap-3 lg:grid-cols-3">{allSizes.map((size) => <SizeCard key={size.id} size={size} period={period} t={t} priceLabel={pricingChip(size).label} priceGood={pricingChip(size).good} onEditPrice={() => setEditingItemId(size.id)} onEditRecipe={() => chooseTab("recipe")} onToggle={() => toggleSize(size)}/>)}</div>{error && <p className="rounded-xl bg-warn-tint p-3 font-semibold text-warn">{error}</p>}
    </section>}

    {tab === "recipe" && <section className="rounded-card-lg bg-card p-[18px]"><RecipeMatrix sizes={stableSortSizes(editSizes)} ingredients={ingredients} ingredientConversions={ingredientConversions}/></section>}

    {addingSize && <AddSizeDialog baseName={editItem.baseName} category={editItem.category} menuGroup={editItem.menuGroup} siblingSizes={allSizes.map((size): SizeSibling => ({ id: size.id, sizeLabel: size.sizeLabel, name: size.name, priceCents: size.priceCents }))} onDone={(id) => { setAddingSize(false); router.push(`/menu/${encodeURIComponent(id)}?tab=overview`); }} onClose={() => setAddingSize(false)}/>}
  </>;
}

function SizeCard({ size, period, t, priceLabel, priceGood, onEditPrice, onEditRecipe, onToggle }: { size: MenuControlItem; period: SalesPeriod; t: ReturnType<typeof useTranslations<"Menu">>; priceLabel: string; priceGood: boolean; onEditPrice: () => void; onEditRecipe: () => void; onToggle: () => void }) {
  const ready = size.costStatus === "READY" && size.ingredientsCostCents !== null;
  const sold = period === "today" ? size.unitsSoldToday : period === "last7" ? size.unitsSoldLast7Days : size.unitsSoldLast30Days;
  return <article className={`flex flex-col gap-3 rounded-card-lg border bg-card p-4 ${size.active ? "border-line" : "border-warn/30 opacity-75"}`}>
    <div className="flex items-center justify-between"><div><h3 className="text-2xl font-bold">{size.sizeLabel ?? size.name}</h3><p className="text-sm text-ink-muted">{size.active ? t("active") : t("inactive")}</p></div><span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#FBF0DF] text-2xl">🥤</span></div>
    <div className="grid grid-cols-3 gap-2 border-y border-line py-3"><Metric label={t("sellingPrice")} value={formatCents(size.priceCents)}/><Metric label={t("costToMake")} value={ready ? formatCents(size.ingredientsCostCents!) : "—"}/><Metric label={t("youKeep")} value={ready ? formatCents(size.priceCents - size.ingredientsCostCents!) : "—"} good={ready}/></div>
    <div className="rounded-xl bg-paper p-3"><span className="text-sm text-ink-muted">{t("totalUnitsSold")}</span><strong className="ms-2 text-2xl">{sold.toLocaleString()}</strong></div>
    <div className="grid grid-cols-2 gap-2"><Status label={t("priceStatus")} value={priceLabel} good={priceGood}/><Status label={t("recipeStatus")} value={ready ? t("complete") : t("needsReview")} good={ready}/></div>
    <div className="grid grid-cols-2 gap-2"><button type="button" onClick={onEditPrice} className="min-h-12 rounded-xl border border-line font-bold"><Pencil className="me-2 inline" aria-hidden size={16}/>{t("editPrice")}</button><button type="button" onClick={onEditRecipe} className={`min-h-12 rounded-xl font-bold ${ready ? "bg-good text-white" : "bg-warn text-white"}`}>{t("editRecipe")}</button></div>
    <button type="button" onClick={onToggle} className="min-h-12 rounded-xl border border-warn/50 font-bold text-warn">{size.active ? t("noLongerServing") : t("serveAgain")}</button>
  </article>;
}
function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) { return <div className="min-w-0"><span className="block text-xs text-ink-muted">{label}</span><strong className={`block break-words text-lg ${good ? "text-good" : "text-ink"}`}>{value}</strong></div>; }
function Status({ label, value, good }: { label: string; value: string; good: boolean }) { return <div className={`rounded-xl p-3 ${good ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}><span className="block text-xs font-semibold">{label}</span><strong className="mt-1 flex items-center gap-1">{good ? <Check aria-hidden size={16}/> : <TriangleAlert aria-hidden size={16}/>} {value}</strong></div>; }
function productFormLabels(t: ReturnType<typeof useTranslations<"ManageMenu">>) { return { nameLabel: t("nameLabel"), sizeLabel: t("sizeLabel"), priceLabel: t("priceLabel"), prepSecondsLabel: t("prepSecondsLabel"), prepSecondsHelp: t("prepSecondsHelp"), menuGroupLabel: t("menuGroupLabel"), itemTypeLabel: t("itemTypeLabel"), itemTypeHelp: t("itemTypeHelp"), saveChanges: t("saveChanges"), itemTypes: { AUTOMATIC: t("itemTypeAutomatic"), ESPRESSO_COFFEE: t("itemTypeEspressoCoffee"), BREWED_COFFEE: t("itemTypeBrewedCoffee"), COLD_BREW: t("itemTypeColdBrew"), TEA: t("itemTypeTea"), OTHER_DRINK: t("itemTypeOtherDrink"), BAKERY: t("itemTypeBakery"), FOOD: t("itemTypeFood"), RETAIL: t("itemTypeRetail") }, itemTypeExamples: { ESPRESSO_COFFEE: t("itemTypeEspressoCoffeeExample"), BREWED_COFFEE: t("itemTypeBrewedCoffeeExample"), OTHER_DRINK: t("itemTypeOtherDrinkExample") } }; }
