"use client";

import { useMemo, useState } from "react";
import { Search, Check, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { groupMenuCatalogItems, isPricingHealthy, type GroupedMenuCatalogItem } from "@/lib/viewmodels/menuCatalogViewModel";
import { usePricingStatusChip } from "./usePricingStatusChip";

function StatusPill({ good, label }: { good: boolean; label: string }) {
  return (
    <span className={`mt-1 inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${good ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>
      {good ? <Check aria-hidden="true" size={13} /> : <TriangleAlert aria-hidden="true" size={13} />}
      {label}
    </span>
  );
}

export default function MenuCatalog({ items }: { items: MenuControlItem[] }) {
  const t = useTranslations("Menu");
  const statusChip = usePricingStatusChip();
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
        if (filter === "attention") return !isPricingHealthy(item);
        if (filter === "all") return true;
        return item.menuGroup === filter;
      }),
    [filter, items, query],
  );

  // Sizes stay separate menu_items everywhere else (data, actions, routes) — grouping only
  // reshapes this already-filtered list for display, after search/tab filtering so those keep
  // working exactly as before.
  const groups = useMemo(() => groupMenuCatalogItems(visible), [visible]);

  function renderPrice(group: GroupedMenuCatalogItem) {
    if (group.priceRange.allSame) return formatCents(group.priceRange.minCents);
    return t("priceRange", { low: formatCents(group.priceRange.minCents), high: formatCents(group.priceRange.maxCents) });
  }

  function renderStatus(group: GroupedMenuCatalogItem) {
    if (group.isSingleSize) {
      const chip = statusChip(group.representativeItem);
      return <StatusPill good={chip.good} label={chip.label} />;
    }
    const status = group.pricingStatus;
    const SecondaryStatus = ({ good, children }: { good?: boolean; children: React.ReactNode }) => (
      <p className={`mt-1 flex items-center gap-1 text-[13px] font-semibold ${good ? "text-good" : "text-warn"}`}>
        {good ? <Check aria-hidden="true" size={14} /> : <TriangleAlert aria-hidden="true" size={14} />}{children}
      </p>
    );
    switch (status.kind) {
      case "all_healthy":
        return <SecondaryStatus good>{t("pricesLookRight")}</SecondaryStatus>;
      case "missing_recipe_one":
        return <SecondaryStatus>{t("sizeRecipeIncomplete", { size: status.sizeLabel ?? group.baseName })}</SecondaryStatus>;
      case "missing_data":
        return <SecondaryStatus>{t("sizesMissingCostInfo", { count: status.count })}</SecondaryStatus>;
      case "needs_review_many":
        return <SecondaryStatus>{t("multipleSizesNeedReview", { count: status.count })}</SecondaryStatus>;
      case "needs_review_one":
        return <SecondaryStatus>{t(status.direction === "low" ? "sizePriceMayBeLowWithSuggestion" : "sizePriceMayBeHighWithSuggestion", { size: status.sizeLabel ?? group.baseName, amount: formatCents(status.suggestedPriceCents) })}</SecondaryStatus>;
    }
  }

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
      <div className="flex flex-col gap-2.5 md:grid md:grid-cols-2 md:gap-3 lg:grid-cols-3">
        {groups.map((group) => (
          <Link key={group.key} href={`/menu/${group.representativeItem.id}`} className="flex flex-col gap-1 rounded-card-lg bg-card p-[18px] text-ink no-underline">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">{group.baseName}</h2>
              {group.sizeLabels.length > 0 && <p className="truncate text-sm text-ink-muted">{group.sizeLabels.join(" · ")}</p>}
            </div>
            <span className="font-headline text-[25px] font-bold">{renderPrice(group)}</span>
            {renderStatus(group)}
          </Link>
        ))}
        {groups.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted md:col-span-full">{t("empty")}</p>}
      </div>
    </>
  );
}
