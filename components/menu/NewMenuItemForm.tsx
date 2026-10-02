"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { addMenuItem } from "@/lib/actions/menuItems";
import { isAmbiguousNumericSizeLabel } from "@/lib/menu/sizeLabel";
import SizeLabelClarifyDialog from "./SizeLabelClarifyDialog";

type Step = 1 | 2;

export default function NewMenuItemForm({ menuGroupOptions }: { menuGroupOptions: string[] }) {
  const t = useTranslations("ManageMenu");
  const common = useTranslations("Common");
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [menuGroup, setMenuGroup] = useState("");
  const [price, setPrice] = useState("");
  const [sizeLabel, setSizeLabel] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [clarifySize, setClarifySize] = useState(false);

  const priceCents = Math.round((Number(price) || 0) * 100);

  function handleCreateClick() {
    if (!name.trim() || priceCents <= 0) return;
    if (isAmbiguousNumericSizeLabel(sizeLabel)) {
      setClarifySize(true);
      return;
    }
    submit(sizeLabel);
  }

  function submit(resolvedSizeLabel: string) {
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem({
        name: name.trim(),
        sizeLabel: resolvedSizeLabel.trim() || undefined,
        priceCents,
        menuGroup: menuGroup.trim() || undefined,
      });
      if (result.ok) router.push(`/menu/${result.id}?setupRecipe=1`);
      else setError(result.error);
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-card-lg bg-card p-5">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className={`h-1.5 flex-1 rounded-full ${step === 1 ? "bg-ink" : "bg-good"}`} />
        <span className={`h-1.5 flex-1 rounded-full ${step === 2 ? "bg-ink" : "bg-line"}`} />
      </div>

      {step === 1 ? (
        <>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {t("nameLabel")}
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {t("menuGroupLabel")}
            <input value={menuGroup} onChange={(event) => setMenuGroup(event.target.value)} list="menu-group-options" className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
          </label>
          <datalist id="menu-group-options">
            {menuGroupOptions.map((group) => <option key={group} value={group} />)}
          </datalist>
          <button type="button" onClick={() => setStep(2)} disabled={!name.trim()} className="h-12 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40">
            {common("next")}
          </button>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {t("priceLabel")}
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-bold text-ink-muted">$</span>
              <input autoFocus type="number" inputMode="decimal" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className="h-12 w-full rounded-xl border border-line px-3 text-base text-ink" />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {t("sizeLabel")}
            <input value={sizeLabel} onChange={(event) => setSizeLabel(event.target.value)} placeholder={t("sizeHint")} className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
          </label>
          {error && <p className="text-sm text-warn">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(1)} className="h-12 flex-1 rounded-full border border-line text-base font-semibold text-ink-muted">
              {common("back")}
            </button>
            <button type="button" onClick={handleCreateClick} disabled={isPending || !price || priceCents <= 0} className="h-12 flex-1 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40">
              {t("createItem")}
            </button>
          </div>
        </>
      )}

      {clarifySize && (
        <SizeLabelClarifyDialog
          value={sizeLabel}
          onResolve={(resolved) => { setSizeLabel(resolved); setClarifySize(false); submit(resolved); }}
          onCancel={() => setClarifySize(false)}
        />
      )}
    </div>
  );
}
