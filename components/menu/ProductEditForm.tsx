"use client";

import { useState, useTransition } from "react";
import { updateMenuItem } from "@/lib/actions/menuItems";
import type { MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import { inferMenuItemCategory } from "@/lib/menu/inferCategory";
import { categoryToOwnerItemType, OWNER_ITEM_TYPE_TO_CATEGORY, OWNER_ITEM_TYPES, type OwnerFacingItemType } from "@/lib/menu/itemType";
import { isAmbiguousNumericSizeLabel } from "@/lib/menu/sizeLabel";
import SizeLabelClarifyDialog from "./SizeLabelClarifyDialog";

export type ProductEditLabels = {
  nameLabel: string;
  sizeLabel: string;
  priceLabel: string;
  prepSecondsLabel: string;
  prepSecondsHelp: string;
  menuGroupLabel: string;
  itemTypeLabel: string;
  itemTypeHelp: string;
  itemTypes: Record<OwnerFacingItemType, string>;
  /** Only the types with a short clarifying example — see docs/02-design-system.md plain-language
   * principle; the rest are self-explanatory from their label alone. */
  itemTypeExamples: Partial<Record<OwnerFacingItemType, string>>;
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
  // The database only ever holds a concrete category, never an "automatic" sentinel, so editing
  // an item preselects the friendly type that category already maps to — never AUTOMATIC itself.
  // The owner can still switch it to Automatic explicitly to hand this item back to inference.
  const [itemType, setItemType] = useState<OwnerFacingItemType>(() => categoryToOwnerItemType(item.category));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [clarifySize, setClarifySize] = useState(false);

  function handleSaveClick() {
    if (isAmbiguousNumericSizeLabel(size)) {
      setClarifySize(true);
      return;
    }
    submit(size);
  }

  function submit(resolvedSize: string) {
    setError(null);
    startTransition(async () => {
      const category = itemType === "AUTOMATIC" ? inferMenuItemCategory(name, menuGroup.trim() || null) : OWNER_ITEM_TYPE_TO_CATEGORY[itemType];
      const result = await updateMenuItem({
        id: item.id,
        name,
        sizeLabel: resolvedSize.trim() || undefined,
        priceCents: Math.round(Number(price) * 100),
        prepSeconds: Math.round(Number(minutes) * 60),
        category,
        menuGroup: menuGroup.trim() || undefined,
      });
      // Only treat this as saved — and close the edit form — when the save actually succeeded.
      // A failed update must stay open with the error visible, not quietly act as if it worked.
      if (result.ok) onSaved?.();
      else setError(result.error);
    });
  }

  const selectedExample = itemType !== "AUTOMATIC" ? labels.itemTypeExamples[itemType] : undefined;

  return (
    <div className="grid gap-2 md:max-w-md">
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
          {labels.itemTypeLabel}
          <select value={itemType} onChange={(event) => setItemType(event.target.value as OwnerFacingItemType)} className="h-11 min-w-0 rounded-lg border border-line bg-card px-2 text-sm text-ink">
            {OWNER_ITEM_TYPES.map((type) => <option key={type} value={type}>{labels.itemTypes[type]}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[11px] font-normal normal-case text-ink-muted">{labels.itemTypeHelp}</p>
      {selectedExample && <p className="text-[11px] font-normal normal-case text-ink-muted">{selectedExample}</p>}
      {error && <p className="text-sm text-warn">{error}</p>}
      <button type="button" disabled={pending} onClick={handleSaveClick} className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-40">
        {labels.saveChanges}
      </button>

      {clarifySize && (
        <SizeLabelClarifyDialog
          value={size}
          onResolve={(resolved) => { setSize(resolved); setClarifySize(false); submit(resolved); }}
          onCancel={() => setClarifySize(false)}
        />
      )}
    </div>
  );
}
