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
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-card-lg bg-card p-5 sm:max-w-md">
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
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-semibold text-ink-muted">{t("recipe")}</legend>
            {siblingSizes.map((sibling, index) => (
              <label key={sibling.id} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${copyFrom === sibling.id ? "border-good bg-good-tint text-good" : "border-line text-ink"}`}>
                <input type="radio" name="copyFrom" checked={copyFrom === sibling.id} onChange={() => setCopyFrom(sibling.id)} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("copyRecipeFrom", { size: sibling.sizeLabel ?? sibling.name })}
                  {index === 0 && <span className="ms-1.5 text-xs font-semibold opacity-70">({t("recommended")})</span>}
                </span>
                <span className="shrink-0 font-semibold">{formatCents(sibling.priceCents)}</span>
              </label>
            ))}
            <label className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${copyFrom === "" ? "border-good bg-good-tint text-good" : "border-line text-ink"}`}>
              <input type="radio" name="copyFrom" checked={copyFrom === ""} onChange={() => setCopyFrom("")} className="shrink-0" />
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
