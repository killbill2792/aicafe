"use client";

import { useTranslations } from "next-intl";
import { resolveSizeLabel, SIZE_LABEL_UNIT_CHOICES } from "@/lib/menu/sizeLabel";

const UNIT_LABEL_KEYS = { oz: "sizeUnitOz", ml: "sizeUnitMl", g: "sizeUnitG", each: "sizeUnitEach" } as const;

/** Shown before Create / Add Size / Edit succeeds when the owner typed a bare number ("16") as a
 * size — too ambiguous to silently store as ounces. Picking a unit turns it into "16 oz" / "16
 * ml" / "16 g" / "16 each"; "Keep as label" stores the number itself, for owners who really did
 * mean "16" as a name (a numbered combo, a seat number, whatever). */
export default function SizeLabelClarifyDialog({
  value,
  onResolve,
  onCancel,
}: {
  value: string;
  onResolve: (resolvedLabel: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("ManageMenu");
  const trimmed = value.trim();

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-card-lg bg-card p-5">
        <h2 className="text-lg font-bold">{t("sizeClarifyTitle", { value: trimmed })}</h2>
        <div className="grid grid-cols-2 gap-2">
          {SIZE_LABEL_UNIT_CHOICES.map((unit) => (
            <button
              key={unit}
              type="button"
              onClick={() => onResolve(resolveSizeLabel(trimmed, unit))}
              className="min-h-12 rounded-xl border border-line text-sm font-bold text-ink"
            >
              {trimmed} {t(UNIT_LABEL_KEYS[unit])}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onResolve(resolveSizeLabel(trimmed, "keep"))} className="min-h-12 rounded-xl border border-line text-sm font-semibold text-ink-muted">
          {t("sizeClarifyKeep", { value: trimmed })}
        </button>
        <button type="button" onClick={onCancel} className="min-h-12 text-sm font-semibold text-ink-muted underline">
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
