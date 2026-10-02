"use client";

import { useMemo, useState } from "react";
import { Search, Check, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { groupMenuCatalogItems } from "@/lib/viewmodels/menuCatalogViewModel";
import { usePricingStatusChip } from "./usePricingStatusChip";

export default function MenuCatalog({ items }: { items: MenuControlItem[] }) {
  const t = useTranslations("Menu");
  const tEdit = useTranslations("ManageMenu");
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
        if (filter === "attention") return item.costStatus !== "READY";
        if (filter === "all") return true;
        return item.menuGroup === filter;
      }),
    [filter, items, query],
  );

  // Sizes stay separate menu_items everywhere else (data, actions, routes) — grouping only
  // reshapes this already-filtered list for display, after search/tab filtering so those keep
  // working exactly as before.
  const groups = useMemo(() => groupMenuCatalogItems(visible), [visible]);

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
        {groups.map((group) => {
          // A single-size product renders exactly as before — same chip, same price, same
          // size line — computed from its one real item. Only a genuinely multi-size product
          // gets the simplified "from $X" / healthy-vs-needs-attention group treatment.
          const chip = group.isSingleSize
            ? statusChip(group.representativeItem)
            : { good: !group.needsAttention, label: group.needsAttention ? tEdit("pricingStatusReview") : tEdit("pricingStatusKeep") };
          return (
            <Link key={group.key} href={`/menu/${group.representativeItem.id}`} className="flex items-center justify-between gap-3 rounded-card-lg bg-card p-[18px] text-ink no-underline">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold">{group.baseName}</h2>
                {group.sizeLabels.length > 0 && <p className="truncate text-sm text-ink-muted">{group.sizeLabels.join(" · ")}</p>}
                <span className={`mt-1 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${chip.good ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>
                  {chip.good ? <Check aria-hidden="true" size={13} /> : <TriangleAlert aria-hidden="true" size={13} />}
                  {chip.label}
                </span>
              </div>
              <span className="shrink-0 font-headline text-[25px] font-bold">
                {group.isSingleSize ? formatCents(group.fromPriceCents) : t("fromPrice", { amount: formatCents(group.fromPriceCents) })}
              </span>
            </Link>
          );
        })}
        {groups.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px] text-ink-muted md:col-span-full">{t("empty")}</p>}
      </div>
    </>
  );
}
