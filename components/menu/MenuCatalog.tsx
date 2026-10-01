"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";

export default function MenuCatalog({ items }: { items: MenuControlItem[] }) {
  const t = useTranslations("Menu");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const groupTabs = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const item of items) {
      if (item.active && item.menuGroup && !seen.has(item.menuGroup)) {
        seen.add(item.menuGroup);
        order.push(item.menuGroup);
      }
    }
    return order;
  }, [items]);

  const tabs = useMemo(
    () => [["all", t("all")], ...groupTabs.map((group) => [group, group]), ["attention", t("needsAttention")], ["archived", t("archived")]] as const,
    [groupTabs, t],
  );

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (!item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return false;
        if (filter === "archived") return !item.active;
        if (!item.active) return false;
        if (filter === "attention") return item.costStatus !== "READY";
        if (filter === "all") return true;
        return item.menuGroup === filter;
      }),
    [filter, items, query],
  );

  return (
    <>
      <label className="flex min-h-12 items-center gap-2 rounded-2xl bg-card px-3 text-ink-muted">
        <Search aria-hidden="true" size={20} />
        <span className="sr-only">{t("search")}</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} className="min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none" />
      </label>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t("all")}>
        {tabs.map(([value, label]) => (
          <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`min-h-12 shrink-0 rounded-full px-4 text-sm font-bold ${filter === value ? "bg-ink text-paper" : "bg-card text-ink"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {visible.map((item) => (
          <Link key={item.id} href={`/menu/${item.id}`} className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px] text-ink no-underline">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{item.name}</h2>
                {item.sizeLabel && <p className="text-sm text-ink-muted">{item.sizeLabel}</p>}
              </div>
              <span className="shrink-0 font-headline text-[25px] font-bold">{formatCents(item.priceCents)}</span>
            </div>
            {item.costStatus !== "READY" || item.ingredientsCostCents === null ? (
              <p className="text-sm font-semibold text-warn">{item.costStatus === "NO_RECIPE" ? t("noRecipe") : t("missingCost", { ingredient: item.missingCostIngredientNames.join(", ") })}</p>
            ) : (
              <p className="text-sm text-ink-muted">
                {t("cost")} <strong className="text-ink">{formatCents(item.ingredientsCostCents)}</strong> ·{" "}
                {t("suggested")}{" "}
                <strong className="text-ink">
                  {!item.pricing || item.pricing.status === "PRICE_UNAVAILABLE" || item.pricing.recommendedPriceCents === null
                    ? t("priceUnavailable")
                    : item.pricing.status === "KEEP_CURRENT_PRICE"
                      ? t("keepPrice")
                      : formatCents(item.pricing.recommendedPriceCents)}
                </strong>
              </p>
            )}
            {item.catalogSource !== "manual" && <p className="text-xs text-ink-muted">{t("syncedFrom", { source: item.provenance.replace("_", " ") })}</p>}
          </Link>
        ))}
        {visible.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted">{t("empty")}</p>}
      </div>
    </>
  );
}
