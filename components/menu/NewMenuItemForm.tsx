"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { addMenuItem } from "@/lib/actions/menuItems";

export default function NewMenuItemForm({ menuGroupOptions }: { menuGroupOptions: string[] }) {
  const t = useTranslations("ManageMenu");
  const router = useRouter();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [menuGroup, setMenuGroup] = useState("");
  const [sizeLabel, setSizeLabel] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    const priceCents = Math.round((Number(price) || 0) * 100);
    if (!name.trim() || priceCents <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem({
        name: name.trim(),
        sizeLabel: sizeLabel.trim() || undefined,
        priceCents,
        menuGroup: menuGroup.trim() || undefined,
      });
      if (result.ok) router.push(`/menu/${result.id}?setupRecipe=1`);
      else setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {t("nameLabel")}
        <input value={name} onChange={(event) => setName(event.target.value)} className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {t("priceLabel")}
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-bold text-ink-muted">$</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className="h-12 w-full rounded-xl border border-line px-3 text-base text-ink" />
        </div>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {t("menuGroupLabel")}
        <input value={menuGroup} onChange={(event) => setMenuGroup(event.target.value)} list="menu-group-options" className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
      </label>
      <datalist id="menu-group-options">
        {menuGroupOptions.map((group) => <option key={group} value={group} />)}
      </datalist>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {t("sizeLabel")}
        <input value={sizeLabel} onChange={(event) => setSizeLabel(event.target.value)} placeholder={t("sizeHint")} className="h-12 rounded-xl border border-line px-3 text-base text-ink" />
      </label>
      {error && <p className="text-sm text-warn">{error}</p>}
      <button type="button" onClick={handleCreate} disabled={isPending || !name.trim() || !price} className="h-12 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40">
        {t("createItem")}
      </button>
    </div>
  );
}
