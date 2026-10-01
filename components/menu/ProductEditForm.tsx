"use client";

import { useState, useTransition } from "react";
import { updateMenuItem } from "@/lib/actions/menuItems";
import type { MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import { MENU_ITEM_CATEGORY_CODES, type MenuItemCategoryCode } from "@/lib/constants";

export type ProductEditLabels = {
  nameLabel: string;
  sizeLabel: string;
  priceLabel: string;
  prepSecondsLabel: string;
  prepSecondsHelp: string;
  menuGroupLabel: string;
  categoryLabel: string;
  categories: Record<MenuItemCategoryCode, string>;
  saveChanges: string;
};

export default function ProductEditForm({
  item,
  menuGroupOptions,
  labels,
  onSaved,
}: {
  item: MenuItemForEdit;
  menuGroupOptions: string[];
  labels: ProductEditLabels;
  onSaved?: () => void;
}) {
  const [name, setName] = useState(item.baseName);
  const [size, setSize] = useState(item.sizeLabel ?? "");
  const [price, setPrice] = useState((item.priceCents / 100).toFixed(2));
  const [minutes, setMinutes] = useState(String(item.prepSeconds / 60));
  const [menuGroup, setMenuGroup] = useState(item.menuGroup ?? "");
  const [category, setCategory] = useState(item.category);
  const [pending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      await updateMenuItem({
        id: item.id,
        name,
        sizeLabel: size || undefined,
        priceCents: Math.round(Number(price) * 100),
        prepSeconds: Math.round(Number(minutes) * 60),
        category,
        menuGroup: menuGroup.trim() || undefined,
      });
      onSaved?.();
    });
  }

  return (
    <div className="grid gap-2">
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {labels.nameLabel}
        <input value={name} onChange={(event) => setName(event.target.value)} className="h-11 rounded-lg border border-line px-3 text-base text-ink" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.sizeLabel}
          <input value={size} onChange={(event) => setSize(event.target.value)} className="h-11 min-w-0 rounded-lg border border-line px-3 text-base text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.priceLabel}
          <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" className="h-11 min-w-0 rounded-lg border border-line px-3 text-base text-ink" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {labels.menuGroupLabel}
        <input
          value={menuGroup}
          onChange={(event) => setMenuGroup(event.target.value)}
          list="menu-group-options"
          className="h-11 min-w-0 rounded-lg border border-line px-3 text-base text-ink"
        />
      </label>
      <datalist id="menu-group-options">
        {menuGroupOptions.map((group) => <option key={group} value={group} />)}
      </datalist>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.prepSecondsLabel}
          <input value={minutes} onChange={(event) => setMinutes(event.target.value)} type="number" min="0.5" step="0.5" className="h-11 min-w-0 rounded-lg border border-line px-3 text-base text-ink" />
          <span className="text-[11px] font-normal normal-case text-ink-muted">{labels.prepSecondsHelp}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.categoryLabel}
          <select value={category} onChange={(event) => setCategory(event.target.value as MenuItemCategoryCode)} className="h-11 min-w-0 rounded-lg border border-line bg-card px-2 text-sm text-ink">
            {MENU_ITEM_CATEGORY_CODES.map((code) => <option key={code} value={code}>{labels.categories[code]}</option>)}
          </select>
        </label>
      </div>
      <button type="button" disabled={pending} onClick={handleSave} className="min-h-11 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-40">
        {labels.saveChanges}
      </button>
    </div>
  );
}
