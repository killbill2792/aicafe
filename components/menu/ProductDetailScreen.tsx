"use client";

import { useState } from "react";
import { Pencil, Check, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { setMenuItemActive } from "@/lib/actions/menuItems";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { IngredientUnitConversion } from "@/lib/calc/recipeUnits";
import { getItemPricingStatus } from "@/lib/viewmodels/menuCatalogViewModel";
import { menuItemHref, type MenuDetailTab } from "@/lib/viewmodels/menuDetail";
import { usePricingStatusChip } from "./usePricingStatusChip";
import ProductEditForm from "./ProductEditForm";
import RecipeEditor from "./RecipeEditor";
import AddSizeDialog, { type SizeSibling } from "./AddSizeDialog";
import { stableSortSizes } from "@/lib/menu/sizeLabel";
import { identicalDifferentSizeRecipe } from "@/lib/menu/identicalSiblingRecipe";

const PRICING_EXPLAINER_KEYS = {
  BENCHMARK_EXPLAINER: "pricingExplainerBenchmark",
  BUSINESS_ADJUSTED_EXPLAINER: "pricingExplainerBusinessAdjusted",
  INCOMPLETE_DATA_EXPLAINER: "pricingExplainerIncomplete",
} as const;

const PRICING_WARNING_KEYS = {
  BUSINESS_ADJUSTMENT_CAPPED: "pricingWarningCapped",
  CATEGORY_PRICE_OUTLIER: "pricingWarningCategoryOutlier",
  CATEGORY_COST_PERCENT_OUTLIER: "pricingWarningCostOutlier",
  INCOMPLETE_RECIPE: "pricingWarningIncompleteRecipe",
  LOW_SAMPLE_SIZE: "pricingWarningLowSample",
} as const;

export default function ProductDetailScreen({
  item,
  editItem,
  ingredients,
  menuGroupOptions,
  ingredientConversions,
  siblingSizes,
  justCreated,
  initialTab,
  initialEditing = false,
  copiedFrom,
}: {
  item: MenuControlItem;
  editItem: MenuItemForEdit;
  ingredients: IngredientOption[];
  menuGroupOptions: string[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>;
  siblingSizes: MenuControlItem[];
  justCreated?: boolean;
  initialTab: MenuDetailTab;
  initialEditing?: boolean;
  copiedFrom?: string;
}) {
  const t = useTranslations("Menu");
  const tEdit = useTranslations("ManageMenu");
  const router = useRouter();
  const pathname = usePathname();
  const statusChip = usePricingStatusChip();
  const [tab, setTab] = useState<MenuDetailTab>(initialTab);
  const [editing, setEditing] = useState(initialEditing);
  const [addingSize, setAddingSize] = useState(false);
  const [managingSizes, setManagingSizes] = useState(false);
  const [isTogglingActive, setIsTogglingActive] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function handleToggleActive() {
    setIsTogglingActive(true);
    setToggleError(null);
    const result = await setMenuItemActive(item.id, !item.active);
    setIsTogglingActive(false);
    // A failed archive/restore must leave the badge and button exactly as they were, with the
    // failure visible — never silently refresh as though the item's state actually changed.
    if (result.ok) router.refresh();
    else setToggleError(result.error);
  }

  const sizeSiblingsForDialog: SizeSibling[] = siblingSizes.map((sibling) => ({ id: sibling.id, sizeLabel: sibling.sizeLabel, name: sibling.name, priceCents: sibling.priceCents }));
  const chip = statusChip(item);
  const pricingStatus = getItemPricingStatus(item);
  const allSizes = stableSortSizes([item, ...siblingSizes]);
  const identicalSibling = identicalDifferentSizeRecipe(editItem, siblingSizes);
  const sameSuggestionSibling = item.pricing?.recommendedPriceCents == null ? null : siblingSizes.find((sibling) => sibling.pricing?.recommendedPriceCents === item.pricing?.recommendedPriceCents);

  const TABS: { key: MenuDetailTab; label: string }[] = [
    { key: "overview", label: t("tabOverview") },
    { key: "recipe", label: t("tabRecipe") },
    { key: "pricing", label: t("tabPricing") },
  ];

  return (
    <>
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <div className="flex min-h-32 items-center justify-center rounded-2xl border border-dashed border-line bg-paper text-center text-ink-muted" aria-label={t("photoPlaceholder")}><span><span className="block text-4xl" aria-hidden="true">☕</span><span className="mt-1 block text-sm font-semibold">{t("photoPlaceholder")}</span></span></div>
        <div><h1 className="font-headline text-3xl font-bold">{item.baseName}</h1><p className="text-sm text-ink-muted">{item.sizeLabel ?? item.name}</p></div>
        {allSizes.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label={t("sizes")}>
            {allSizes.map((size) => (
              <Link
                key={size.id}
                href={menuItemHref(size.id, tab)}
                aria-current={size.id === item.id ? "page" : undefined}
                className={`flex min-h-12 shrink-0 items-center rounded-full border px-4 text-sm font-bold no-underline ${size.id === item.id ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink"}`}
              >
                {size.sizeLabel ?? size.name}
              </Link>
            ))}
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-end gap-3">
            <span className="text-[17px] text-ink-muted">{t("sellingPrice")}</span>
            <strong className="font-headline text-4xl">{formatCents(item.priceCents)}</strong>
          </div>
          <button type="button" onClick={() => setEditing((prev) => !prev)} className="flex min-h-12 items-center gap-1.5 rounded-full border border-line px-3 text-sm font-bold text-ink">
            <Pencil aria-hidden="true" size={16} /> {t("editAction")}
          </button>
        </div>
        {item.catalogSource !== "manual" && <p className="text-sm text-ink-muted">{t("syncedFrom", { source: item.provenance.replace("_", " ") })}</p>}
        <span className={`w-fit rounded-full px-3 py-1 text-sm font-bold ${item.active ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>{item.active ? t("active") : t("inactive")}</span>
        <span className={`inline-flex w-fit items-center gap-1.5 text-sm font-bold ${chip.good ? "text-good" : "text-warn"}`}>{chip.label}</span>
        <button type="button" onClick={() => setManagingSizes((value) => !value)} className="min-h-12 w-fit rounded-full border border-line px-4 text-sm font-bold">{t("manageSizes")}</button>
      </section>
        {editing && (
          <section className="rounded-card-lg border border-line bg-card p-[18px]">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-bold">{t("editProduct")}</h2><button type="button" onClick={() => setEditing(false)} className="min-h-12 px-3 font-semibold text-ink-muted">{tEdit("cancel")}</button></div>
            <ProductEditForm
              item={editItem}
              menuGroupOptions={menuGroupOptions}
              labels={{
                nameLabel: tEdit("nameLabel"), sizeLabel: tEdit("sizeLabel"), priceLabel: tEdit("priceLabel"), prepSecondsLabel: tEdit("prepSecondsLabel"), prepSecondsHelp: tEdit("prepSecondsHelp"),
                menuGroupLabel: tEdit("menuGroupLabel"), itemTypeLabel: tEdit("itemTypeLabel"), itemTypeHelp: tEdit("itemTypeHelp"), saveChanges: tEdit("saveChanges"),
                itemTypes: {
                  AUTOMATIC: tEdit("itemTypeAutomatic"), ESPRESSO_COFFEE: tEdit("itemTypeEspressoCoffee"), BREWED_COFFEE: tEdit("itemTypeBrewedCoffee"), COLD_BREW: tEdit("itemTypeColdBrew"),
                  TEA: tEdit("itemTypeTea"), OTHER_DRINK: tEdit("itemTypeOtherDrink"), BAKERY: tEdit("itemTypeBakery"), FOOD: tEdit("itemTypeFood"), RETAIL: tEdit("itemTypeRetail"),
                },
                itemTypeExamples: {
                  ESPRESSO_COFFEE: tEdit("itemTypeEspressoCoffeeExample"), BREWED_COFFEE: tEdit("itemTypeBrewedCoffeeExample"), OTHER_DRINK: tEdit("itemTypeOtherDrinkExample"),
                },
              }}
              onSaved={() => { setEditing(false); router.refresh(); }}
            />
          </section>
        )}

      {managingSizes && <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]"><h2 className="text-xl font-bold">{t("manageSizes")}</h2>
        {allSizes.map((size) => <Link key={size.id} href={menuItemHref(size.id, tab)} className="flex min-h-20 items-center justify-between gap-3 rounded-xl border border-line p-3 text-ink no-underline"><span><strong>{size.sizeLabel ?? size.name}</strong><span className="block text-sm text-ink-muted">{size.costStatus === "READY" && size.ingredientsCostCents !== null ? t("sizeCostToMake", { amount: formatCents(size.ingredientsCostCents) }) : t("recipeIncomplete")} · {size.active ? t("active") : t("inactive")}</span></span><strong>{formatCents(size.priceCents)}</strong></Link>)}
        <button type="button" onClick={() => setAddingSize(true)} className="min-h-12 rounded-full border border-good px-4 font-semibold text-good">{tEdit("addAnotherSize", { name: editItem.baseName })}</button>
      </section>}

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist">
        {TABS.map(({ key, label }) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); router.replace(`${pathname}?tab=${key}`, { scroll: false }); }} className={`min-h-12 shrink-0 rounded-full px-4 text-sm font-bold ${tab === key ? "bg-ink text-paper" : "bg-card text-ink"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="flex flex-col gap-3 md:grid md:grid-cols-2 md:items-start md:gap-3">
          <section className="flex flex-col justify-center gap-1 rounded-card-lg bg-card p-[18px]">
            <Row label={t("selectedSize")} value={item.sizeLabel ?? item.baseName} strong />
            <Row label={t("sellingPrice")} value={formatCents(item.priceCents)} />
            {item.costStatus === "READY" && item.ingredientsCostCents !== null ? (
              <><Row label={t("costToMake")} value={formatCents(item.ingredientsCostCents)} /><Row label={t("keptAfterIngredients")} value={formatCents(item.priceCents - item.ingredientsCostCents)} strong /></>
            ) : (
              <strong className="text-lg text-warn">{item.costStatus === "NO_RECIPE" ? t("noRecipe") : t("missingCost", { ingredient: item.missingCostIngredientNames.join(", ") })}</strong>
            )}
          </section>
          <section className={`flex flex-col gap-1 rounded-card-lg border p-[18px] ${chip.good ? "border-good/20 bg-good-tint" : "border-warn/25 bg-warn-tint"}`}>
            <span className={`inline-flex w-fit items-center gap-1.5 text-sm font-bold ${chip.good ? "text-good" : "text-warn"}`}>
              {chip.good ? <Check aria-hidden="true" size={16} /> : <TriangleAlert aria-hidden="true" size={16} />}
              {chip.label}
            </span>
            {(pricingStatus.kind === "low" || pricingStatus.kind === "high") && (
              <div className="mt-0.5 flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-muted">{t("youCharge")}</span>
                  <span className="font-semibold">{formatCents(item.priceCents)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-muted">{t("suggested")}</span>
                  <span className="font-bold text-warn">{formatCents(pricingStatus.suggestedPriceCents)}</span>
                </div>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px] md:col-span-2">
            <h2 className="text-lg font-bold">{t("recentSales")}</h2>
            {item.unitsSold === null && item.revenueCents === null ? (
              <p className="text-ink-muted">{t("noSalesHistory")}</p>
            ) : (
              <>
                {item.unitsSold !== null && <Row label={t("unitsSold")} value={String(item.unitsSold)} />}
                {item.revenueCents !== null && <Row label={t("revenue")} value={formatCents(item.revenueCents)} />}
              </>
            )}
          </section>
        </div>
      )}

      {tab === "recipe" && (
        <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
          <h2 className="text-xl font-bold">{t("sizeRecipe", { size: item.sizeLabel ?? item.name })}</h2>
          {copiedFrom && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{t("recipeCopiedReview", { from: copiedFrom, to: item.sizeLabel ?? item.name })}</p>}
          {!copiedFrom && identicalSibling && <p className="rounded-xl bg-warn-tint p-3 text-sm text-warn">{t("identicalRecipeReview", { other: identicalSibling, size: item.sizeLabel ?? item.name })}</p>}
          {justCreated && (
            <p className="rounded-xl bg-good-tint px-3 py-2.5 text-sm font-semibold text-good">{t("setupRecipeBanner")}</p>
          )}
          <RecipeEditor item={editItem} ingredients={ingredients} ingredientConversions={ingredientConversions} />
        </section>
      )}

      {tab === "pricing" && (
        <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
          <Row label={t("sellingPrice")} value={formatCents(item.priceCents)} strong />
          {item.costStatus === "READY" && item.ingredientsCostCents !== null ? (
            <p className="text-[17px]">{t("costsAboutToMake", { amount: formatCents(item.ingredientsCostCents) })}</p>
          ) : (
            <p className="text-[17px] text-warn">{item.costStatus === "NO_RECIPE" ? t("noRecipe") : t("missingCost", { ingredient: item.missingCostIngredientNames.join(", ") })}</p>
          )}
          <div className={`flex flex-col gap-1.5 rounded-xl p-3 ${chip.good ? "bg-good-tint" : "bg-warn-tint"}`}>
            <span className={`inline-flex w-fit items-center gap-1.5 text-sm font-bold ${chip.good ? "text-good" : "text-warn"}`}>
              {chip.good ? <Check aria-hidden="true" size={16} /> : <TriangleAlert aria-hidden="true" size={16} />}
              {chip.label}
            </span>
            {(pricingStatus.kind === "low" || pricingStatus.kind === "high") && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink-muted">{t("suggested")}</span>
                <strong className="text-lg text-warn">{formatCents(pricingStatus.suggestedPriceCents)}</strong>
              </div>
            )}
            {item.pricing && item.pricing.status !== "PRICE_UNAVAILABLE" && (
              <p className="text-sm text-ink-muted">
                <span className="font-semibold">{tEdit("whyLabel")}</span> {tEdit(PRICING_EXPLAINER_KEYS[item.pricing.explanationCode])}
              </p>
            )}
            {item.pricing?.warnings.map((warning) => (
              <p key={warning} className="text-sm font-semibold text-warn">{tEdit(PRICING_WARNING_KEYS[warning])}</p>
            ))}
            {item.pricing && <p className="text-sm text-ink-muted">{t("pricingConfidence", { confidence: item.pricing.confidence, quality: item.pricing.dataQuality.estimatedInputs.length > 0 ? t("estimatedData") : t("completeData") })}</p>}
            {sameSuggestionSibling && <p className="text-sm text-ink-muted">{t("sameSuggestedReason", { size: sameSuggestionSibling.sizeLabel ?? sameSuggestionSibling.name })}</p>}
          </div>
        </section>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleToggleActive}
          disabled={isTogglingActive}
          className="flex min-h-12 items-center justify-center rounded-full border border-line bg-card px-4 font-bold text-ink disabled:opacity-40"
        >
          {item.active ? t("archiveItem") : t("restoreToMenu")}
        </button>
        {toggleError && <p className="text-sm text-warn">{toggleError}</p>}
      </div>

      {addingSize && (
        <AddSizeDialog
          baseName={editItem.baseName}
          category={editItem.category}
          menuGroup={editItem.menuGroup}
          siblingSizes={[{ id: editItem.id, sizeLabel: editItem.sizeLabel, name: editItem.name, priceCents: editItem.priceCents }, ...sizeSiblingsForDialog]}
          onDone={(newItemId, source) => { setAddingSize(false); router.push(`${menuItemHref(newItemId, "recipe")}${source ? `&copiedFrom=${encodeURIComponent(source)}` : ""}`); }}
          onClose={() => setAddingSize(false)}
        />
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[17px]">
      <span className="text-ink-muted">{label}</span>
      <span className={strong ? "font-bold text-good" : "font-semibold"}>{value}</span>
    </div>
  );
}
