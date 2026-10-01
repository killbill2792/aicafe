"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { addMenuItem } from "@/lib/actions/menuItems";
import { formatCents } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";

export type SizeSibling = { id: string; sizeLabel: string | null; name: string; priceCents: number };

export default function AddSizeDialog({
  baseName,
  category,
  menuGroup,
  siblingSizes,
  onDone,
  onClose,
}: {
  baseName: string;
  category: MenuItemCategoryCode;
  menuGroup: string | null;
  siblingSizes: SizeSibling[];
  onDone: (newItemId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("ManageMenu");
  const [sizeLabel, setSizeLabel] = useState("");
  const [price, setPrice] = useState("");
  const [copyFrom, setCopyFrom] = useState<string>(siblingSizes[0]?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    const priceCents = Math.round((Number(price) || 0) * 100);
    if (!sizeLabel.trim() || priceCents <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem({
        name: baseName,
        sizeLabel: sizeLabel.trim(),
        priceCents,
        category,
        menuGroup: menuGroup ?? undefined,
        copyRecipeFromItemId: copyFrom || undefined,
      });
      if (result.ok) onDone(result.id);
      else setError(result.error);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-lg font-bold">{t("addSizeTitle", { name: baseName })}</h2>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("sizeLabel")}
          <input value={sizeLabel} onChange={(event) => setSizeLabel(event.target.value)} placeholder={t("sizeHint")} className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {t("priceLabel")}
          <div className="flex items-center gap-1.5">
            <span className="text-lg font-bold text-ink-muted">$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className="h-12 w-full rounded-xl border border-line px-3 text-base text-ink" />
          </div>
        </label>
        {siblingSizes.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-semibold text-ink-muted">{t("recipe")}</legend>
            {siblingSizes.map((sibling) => (
              <label key={sibling.id} className="flex items-center gap-2 text-sm text-ink">
                <input type="radio" name="copyFrom" checked={copyFrom === sibling.id} onChange={() => setCopyFrom(sibling.id)} />
                {t("copyRecipeFrom", { size: sibling.sizeLabel ?? sibling.name })} · {formatCents(sibling.priceCents)}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="radio" name="copyFrom" checked={copyFrom === ""} onChange={() => setCopyFrom("")} />
              {t("createSeparately")}
            </label>
          </fieldset>
        )}
        {error && <p className="text-sm text-warn">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="h-12 flex-1 rounded-full border border-line text-base font-semibold text-ink-muted">{t("cancel")}</button>
          <button type="button" onClick={handleSubmit} disabled={isPending || !sizeLabel.trim() || !price} className="h-12 flex-1 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40">{t("addSize")}</button>
        </div>
      </div>
    </div>
  );
}
