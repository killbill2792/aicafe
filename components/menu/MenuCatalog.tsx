"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Check, Coffee, Search, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { groupMenuCatalogItems, isPricingHealthy, type GroupedMenuCatalogItem } from "@/lib/viewmodels/menuCatalogViewModel";
import { usePricingStatusChip } from "./usePricingStatusChip";
import type { ProductPhoto } from "@/lib/data/getProductPhoto";

function StatusLine({ good, label }: { good: boolean; label: string }) {
  return (
    <span className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm font-bold ${good ? "bg-good-tint text-good" : "bg-amber-50 text-warn"}`}>
      {good ? <Check className="mt-0.5 shrink-0" size={17} aria-hidden="true" /> : <TriangleAlert className="mt-0.5 shrink-0" size={17} aria-hidden="true" />}{label}
    </span>
  );
}

export default function MenuCatalog({ items, photos }: { items: MenuControlItem[]; photos: Record<string, ProductPhoto> }) {
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
      const status = group.pricingStatus;
      const suggested = status.kind === "needs_review_one" ? ` · ${t("suggested")} ${formatCents(status.suggestedPriceCents)}` : "";
      return <StatusLine good={chip.good} label={`${chip.label}${suggested}`} />;
    }
    const status = group.pricingStatus;
    switch (status.kind) {
      case "all_healthy":
        return <StatusLine good label={t("pricesLookRight")} />;
      case "missing_recipe_one":
        return <StatusLine good={false} label={t("sizeRecipeIncomplete", { size: status.sizeLabel ?? group.baseName })} />;
      case "missing_data":
        return <StatusLine good={false} label={t("sizesMissingCostInfo", { count: status.count })} />;
      case "needs_review_many":
        return <StatusLine good={false} label={t("multipleSizesNeedReview", { count: status.count })} />;
      case "needs_review_one":
        return (
          <StatusLine
            good={false}
            label={`${t(status.direction === "low" ? "sizePriceMayBeLow" : "sizePriceMayBeHigh", { size: status.sizeLabel ?? group.baseName })} · ${t("suggested")} ${formatCents(status.suggestedPriceCents)}`}
          />
        );
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
      <div className="flex flex-col gap-3 md:grid md:grid-cols-2 lg:grid-cols-3">
        {groups.map((group) => {
          const photo = group.memberIds.map((id) => photos[id]).find(Boolean) ?? null;
          return <Link key={group.key} href={`/menu/${group.representativeItem.id}`} className="group overflow-hidden rounded-card-lg border border-line/70 bg-card text-ink no-underline shadow-sm transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            <div className="flex gap-4 p-4">
              <div className="relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[#fbf1e3] text-[#7a3f13]">
                {photo ? <Image src={photo.signedUrl} alt="" fill unoptimized sizes="112px" className="object-cover transition-transform group-hover:scale-[1.02] motion-reduce:transform-none" /> : <Coffee size={42} strokeWidth={1.8} aria-hidden="true" />}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <h2 className="text-xl font-extrabold leading-tight">{group.baseName}</h2>
                {group.sizeLabels.length > 0 && <p className="mt-1 line-clamp-2 text-[15px] text-ink-muted">{group.sizeLabels.join(" · ")}</p>}
                <p className="mt-2 font-headline text-[25px] font-bold leading-none">{renderPrice(group)}</p>
              </div>
            </div>
            <div className="px-4 pb-4">{renderStatus(group)}</div>
          </Link>;
        })}
        {groups.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted md:col-span-full">{t("empty")}</p>}
      </div>
    </>
  );
}
