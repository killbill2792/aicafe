import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildMenuViewModel } from "@/lib/viewmodels/menuViewModel";
import Money from "@/components/shared/Money";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import MenuItemBar from "@/components/menu/MenuItemBar";
import MenuSortSwitch from "@/components/menu/MenuSortSwitch";
import { formatCents } from "@/lib/calc";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function MenuPage({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  await requireOwnBusiness();
  const { sort: sortParam } = await searchParams;
  const sort = sortParam === "total" ? "total" : "perCup";

  const snapshot = await getSnapshot();
  const vm = buildMenuViewModel(snapshot);
  const t = await getTranslations("Menu");

  const sortedItems =
    sort === "total"
      ? [...vm.items].sort((a, b) => b.yoursCents * b.item.quantitySoldLast28Days - a.yoursCents * a.item.quantitySoldLast28Days)
      : vm.items;

  const insightIsBest = vm.bestEarner && vm.lowestEarner && vm.bestEarner.item.id !== vm.lowestEarner.item.id;

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-xl font-bold text-ink">{t("headline")}</div>
          <div className="text-sm font-medium text-ink-muted">{t("subhead")}</div>
        </div>
        <LanguageSwitch href="/menu" />
      </header>

      {vm.featured && (
        <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-bold">{vm.featured.item.name}</span>
            <span className="font-headline text-[26px] font-bold">{formatCents(vm.featured.item.priceCents)}</span>
          </div>
          <MenuItemBar breakdown={vm.featured} tall yoursLabel={t("yours")} />
          <div className="flex flex-wrap gap-3.5 text-[13px] font-medium text-ink-muted">
            <Legend color="bg-ingredients" label={t("legendIngredients")} />
            <Legend color="bg-staff" label={t("legendStaff")} />
            <Legend color="bg-fees" label={t("legendCardFee")} />
            <Legend color="bg-running" label={t("legendRent")} />
          </div>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <span className="text-[15px] text-ink-muted">{t("youKeepPer", { name: vm.featured.item.name })}</span>
              <span className="text-lg font-bold text-good">
                <Money cents={Math.max(0, vm.featured.yoursCents)} />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[15px] text-ink-muted">{t("eachExtraAdds")}</span>
              <span className="text-lg font-bold">
                <Money cents={Math.max(0, vm.featured.extraMoneyCents)} />
              </span>
            </div>
          </div>
          <p className="m-0 text-sm leading-snug text-ink-muted">{t("rentShareNote")}</p>
        </section>
      )}

      <section className="flex flex-col gap-3.5 rounded-card-lg bg-card px-[18px] py-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[17px] font-bold">{t("wholeMenu")}</span>
          <MenuSortSwitch current={sort} perCupLabel={t("sortPerCup")} totalLabel={t("sortTotal")} />
        </div>
        <div className="flex flex-col gap-4">
          {sortedItems.map((breakdown) => (
            <div key={breakdown.item.id} className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[15px]">
                <span className="font-semibold">
                  {breakdown.item.name} · {formatCents(breakdown.item.priceCents)}
                </span>
                <span className={`font-bold ${breakdown.yoursCents < 0 ? "text-warn" : ""}`}>
                  <Money cents={breakdown.yoursCents} />
                </span>
              </div>
              <MenuItemBar breakdown={breakdown} yoursLabel={t("yours")} />
            </div>
          ))}
        </div>
      </section>

      {insightIsBest && vm.bestEarner && vm.lowestEarner && (
        <section className="flex flex-col gap-2 rounded-[20px] bg-good-tint p-4">
          <div className="text-base font-bold text-[#1E4D37]">{t("pushInsight", { name: vm.bestEarner.item.name })}</div>
          <div className="text-[15px] leading-snug text-[#1E4D37]">
            {t("insightBody", {
              deltaAmount: formatCents(vm.bestEarner.yoursCents - vm.lowestEarner.yoursCents),
              lowName: vm.lowestEarner.item.name,
            })}
          </div>
        </section>
      )}

      <p className="mx-1 text-[13px] leading-snug text-ink-muted">{t("staffTimeExplainer")}</p>
    </main>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-[3px] ${color}`} />
      {label}
    </span>
  );
}
