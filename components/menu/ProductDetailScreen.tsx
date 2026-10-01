"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { setMenuItemActive } from "@/lib/actions/menuItems";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { IngredientUnitConversion } from "@/lib/calc/recipeUnits";
import ProductEditForm from "./ProductEditForm";
import RecipeEditor from "./RecipeEditor";
import AddSizeDialog, { type SizeSibling } from "./AddSizeDialog";

export default function ProductDetailScreen({
  item,
  editItem,
  ingredients,
  menuGroupOptions,
  ingredientConversions,
  siblingSizes,
}: {
  item: MenuControlItem;
  editItem: MenuItemForEdit;
  ingredients: IngredientOption[];
  menuGroupOptions: string[];
  ingredientConversions: Record<string, IngredientUnitConversion[]>;
  siblingSizes: MenuItemForEdit[];
}) {
  const t = useTranslations("Menu");
  const tEdit = useTranslations("ManageMenu");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [addingSize, setAddingSize] = useState(false);
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

  return (
    <>
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-end gap-3">
            <span className="text-[17px] text-ink-muted">{t("sellingPrice")}</span>
            <strong className="font-headline text-4xl">{formatCents(item.priceCents)}</strong>
          </div>
          <button type="button" onClick={() => setEditing((prev) => !prev)} className="flex min-h-10 items-center gap-1.5 rounded-full border border-line px-3 text-sm font-bold text-ink">
            <Pencil aria-hidden="true" size={16} /> {t("editAction")}
          </button>
        </div>
        {item.catalogSource !== "manual" && <p className="text-sm text-ink-muted">{t("syncedFrom", { source: item.provenance.replace("_", " ") })}</p>}
        <span className={`w-fit rounded-full px-3 py-1 text-sm font-bold ${item.active ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>{item.active ? t("active") : t("inactive")}</span>
        {editing && (
          <div className="border-t border-line pt-3">
            <ProductEditForm
              item={editItem}
              menuGroupOptions={menuGroupOptions}
              labels={{
                nameLabel: tEdit("nameLabel"), sizeLabel: tEdit("sizeLabel"), priceLabel: tEdit("priceLabel"), prepSecondsLabel: tEdit("prepSecondsLabel"), prepSecondsHelp: tEdit("prepSecondsHelp"),
                menuGroupLabel: tEdit("menuGroupLabel"), categoryLabel: tEdit("categoryLabel"), saveChanges: tEdit("saveChanges"),
                categories: {
                  ESPRESSO_DRINK: tEdit("categoryEspressoDrink"), BREWED_COFFEE: tEdit("categoryBrewedCoffee"), COLD_BREW: tEdit("categoryColdBrew"), TEA: tEdit("categoryTea"),
                  SPECIALTY_DRINK: tEdit("categorySpecialtyDrink"), PASTRY: tEdit("categoryPastry"), FOOD: tEdit("categoryFood"), RETAIL: tEdit("categoryRetail"),
                },
              }}
              onSaved={() => { setEditing(false); router.refresh(); }}
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <RecipeEditor item={editItem} ingredients={ingredients} ingredientConversions={ingredientConversions} pricingResult={item.pricing ?? undefined} />
      </section>

      <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]">
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

      <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-lg font-bold">{t("sizes")}</h2>
        <Row label={editItem.sizeLabel ?? editItem.baseName} value={formatCents(editItem.priceCents)} strong />
        {siblingSizes.map((sibling) => <Row key={sibling.id} label={sibling.sizeLabel ?? sibling.name} value={formatCents(sibling.priceCents)} />)}
        <button type="button" onClick={() => setAddingSize(true)} className="mt-1 text-sm font-semibold text-good">
          {tEdit("addAnotherSize", { name: editItem.baseName })}
        </button>
      </section>

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
          onDone={(newItemId) => { setAddingSize(false); router.push(`/menu/${newItemId}`); }}
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
